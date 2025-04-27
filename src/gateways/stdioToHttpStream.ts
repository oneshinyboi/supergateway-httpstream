import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { createServer } from 'http'
import { v4 as uuidv4 } from 'uuid'

export interface StdioToHttpStreamArgs {
  stdioCmd: string
  port: number
  endpoint: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  responseMode: 'batch' | 'stream'
  batchTimeout: number
  sessionHeaderName: string
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

export async function stdioToHttpStream(args: StdioToHttpStreamArgs) {
  const {
    stdioCmd,
    port,
    endpoint,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    responseMode,
    batchTimeout,
    sessionHeaderName,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - endpoint: ${endpoint}`)
  logger.info(`  - responseMode: ${responseMode}`)
  logger.info(`  - batchTimeout: ${batchTimeout}ms`)
  logger.info(`  - sessionHeaderName: ${sessionHeaderName}`)
  logger.info(
    `  - CORS: enabled (${corsOrigin ? serializeCorsOrigin({ corsOrigin }) : '*'})`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  // Sessions store
  const sessions: Record<
    string,
    {
      responses: Map<string, express.Response>
      pendingRequests: Map<string, JSONRPCMessage>
      messageHistory: JSONRPCMessage[]
      lastEventId: number
    }
  > = {}

  const app = express()

  // Always enable CORS, but use specified origins if provided
  app.use(
    cors({
      origin: corsOrigin || '*',
      methods: 'GET, POST, DELETE, OPTIONS',
      allowedHeaders:
        'Content-Type, Accept, Authorization, x-api-key, Last-Event-ID',
      exposedHeaders: 'Content-Type, Authorization, x-api-key, Mcp-Session-Id',
      credentials: true,
    }),
  )

  app.use(bodyParser.json({ limit: '4mb' }))

  // Health endpoints
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  // Helper to generate and send SSE events
  const sendSSEEvent = (
    res: express.Response,
    sessionId: string,
    data: any,
    eventId?: number,
  ) => {
    if (!sessions[sessionId]) return false

    const id = eventId ?? ++sessions[sessionId].lastEventId

    res.write(`id: ${id}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)

    // Store in message history for resumability
    sessions[sessionId].messageHistory.push(data)

    // Trim history if needed (default limit to last 100 messages)
    if (sessions[sessionId].messageHistory.length > 100) {
      sessions[sessionId].messageHistory.shift()
    }

    return true
  }

  // Common session handling logic
  const getOrCreateSession = (req: express.Request, res: express.Response) => {
    // Set response headers
    setResponseHeaders({
      res,
      headers,
    })

    // Session management
    let sessionId = req.header(sessionHeaderName)

    // Create new session if needed
    if (!sessionId || !sessions[sessionId]) {
      sessionId = uuidv4()
      sessions[sessionId] = {
        responses: new Map(),
        pendingRequests: new Map(),
        messageHistory: [],
        lastEventId: 0,
      }
      logger.info(`New session created: ${sessionId}`)
    } else {
      logger.info(`Using existing session: ${sessionId}`)
    }

    // Always ensure the session ID is in the response headers
    res.setHeader(sessionHeaderName, sessionId)
    return sessionId
  }

  // Set up route handlers
  const handleOptions = (req: express.Request, res: express.Response) => {
    setResponseHeaders({
      res,
      headers,
    })
    res.status(204).end()
  }

  const handleDelete = (req: express.Request, res: express.Response) => {
    setResponseHeaders({
      res,
      headers,
    })

    const sessionId = req.header(sessionHeaderName)

    if (!sessionId) {
      res.setHeader('Content-Type', 'application/json')
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Missing session ID',
        },
        id: null,
      })
    }

    if (sessions[sessionId]) {
      // Close all open responses
      for (const [, response] of sessions[sessionId].responses) {
        response.end()
      }
      delete sessions[sessionId]
      logger.info(`Session terminated: ${sessionId}`)
      return res.status(204).end()
    } else {
      res.setHeader('Content-Type', 'application/json')
      return res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Session ${sessionId} not found`,
        },
        id: null,
      })
    }
  }

  const handleGet = (req: express.Request, res: express.Response) => {
    const sessionId = getOrCreateSession(req, res)

    // Setup SSE connection
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // Send connected event
    res.write(`event: connected\ndata: {"sessionId": "${sessionId}"}\n\n`)

    // Handle Last-Event-ID for stream resumability
    const lastEventId = req.header('Last-Event-ID')
    if (lastEventId) {
      const lastId = parseInt(lastEventId, 10)
      // Replay missed events if any
      const missedEvents = sessions[sessionId].messageHistory.filter(
        (_, index) => index >= lastId,
      )
      for (const [index, event] of missedEvents.entries()) {
        sendSSEEvent(res, sessionId, event, lastId + index)
      }
    }

    // Add this response to the session's responses
    const responseId = uuidv4()
    sessions[sessionId].responses.set(responseId, res)

    // Handle client disconnect
    req.on('close', () => {
      if (sessions[sessionId]) {
        sessions[sessionId].responses.delete(responseId)
        // Optional: clean up session if no active connections
        if (sessions[sessionId].responses.size === 0) {
          // Keep session for resumability
        }
      }
    })
  }

  const handlePost = (req: express.Request, res: express.Response) => {
    const sessionId = getOrCreateSession(req, res)

    // Extract JSON-RPC message
    const message = req.body

    if (!message || typeof message !== 'object') {
      res.setHeader('Content-Type', 'application/json')
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error: Invalid JSON',
        },
        id: null,
      })
    }

    // Process the message
    logger.info(
      `HTTP → Child (session ${sessionId}): ${JSON.stringify(message)}`,
    )

    // Make sure we set the content type right away
    res.setHeader('Content-Type', 'application/json')

    // Special handling for initialize requests to ensure correct response
    const isInitializeRequest = message.method === 'initialize'

    // If this is an initialize request, we need to be extra careful with handling
    if (isInitializeRequest) {
      logger.info(`Processing initialize request for session ${sessionId}`)
    }

    // Send message to child process
    child.stdin.write(JSON.stringify(message) + '\n')

    // For stream mode, set up SSE response
    if (responseMode === 'stream') {
      // Override the content type for SSE
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // Store the request ID for pairing with responses
      if (message.id) {
        sessions[sessionId].pendingRequests.set(message.id.toString(), message)

        // Set up request timeout
        setTimeout(() => {
          if (sessions[sessionId]?.pendingRequests.has(message.id.toString())) {
            // Request timed out
            sessions[sessionId].pendingRequests.delete(message.id.toString())
            sendSSEEvent(res, sessionId, {
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Request timeout',
              },
              id: message.id,
            })
            res.end()
          }
        }, batchTimeout)
      }
    } else {
      // For batch mode, store the request and response for later
      if (message.id) {
        // Add response to pending batch
        const requestId = message.id.toString()
        sessions[sessionId].pendingRequests.set(requestId, message)

        // For initialize requests, we need to wait for the response before proceeding
        // Do not send immediate confirmation - wait for the actual response

        // Set up the timeout to send batch response
        setTimeout(() => {
          if (res.writableEnded) return

          // If no response was sent yet, send error
          if (sessions[sessionId]?.pendingRequests.has(requestId)) {
            sessions[sessionId].pendingRequests.delete(requestId)
            res.setHeader('Content-Type', 'application/json')
            res.status(504).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Request timeout',
              },
              id: message.id,
            })
          }
        }, batchTimeout)
      } else {
        // For notifications (no ID), just send 204 No Content
        return res.status(204).end()
      }
    }
  }

  // Register the endpoints using middleware
  app.use(endpoint, (req, res) => {
    if (req.method === 'OPTIONS') {
      handleOptions(req, res)
    } else if (req.method === 'DELETE') {
      handleDelete(req, res)
    } else if (req.method === 'GET') {
      handleGet(req, res)
    } else if (req.method === 'POST') {
      handlePost(req, res)
    } else {
      res.setHeader('Content-Type', 'application/json')
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Method ${req.method} not allowed`,
        },
        id: null,
      })
    }
  })

  const httpServer = createServer(app)
  httpServer.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`HTTP Stream endpoint: http://localhost:${port}${endpoint}`)
  })

  // Handle child process output
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')

    // Process complete lines only, keeping incomplete lines in the buffer
    let lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → HTTP:', jsonMsg)

        // Process response for all active sessions
        for (const [sessionId, session] of Object.entries(sessions)) {
          try {
            // If this is a response to a specific request
            if (jsonMsg.id !== undefined) {
              const requestId = jsonMsg.id.toString()

              // Check if we have a pending request for this ID
              const pendingRequest = session.pendingRequests.get(requestId)
              if (pendingRequest) {
                session.pendingRequests.delete(requestId)

                // Ensure we have a complete and valid JSON-RPC response
                const validResponse = {
                  jsonrpc: '2.0',
                  ...(jsonMsg.result ? { result: jsonMsg.result } : {}),
                  ...(jsonMsg.error ? { error: jsonMsg.error } : {}),
                  id: jsonMsg.id,
                }

                // Find if there's a specific request waiting for this response
                // For batch mode, we might have stored the response object
                if (responseMode === 'batch') {
                  // In a real implementation, we would need to track which response belongs
                  // to which request, but for simplicity we'll just return the result
                  // to any client that's still waiting for the response
                  for (const [, response] of session.responses) {
                    if (!response.writableEnded) {
                      logger.info(
                        `Sending response for request ${requestId} to client`,
                      )
                      response.setHeader('Content-Type', 'application/json')
                      response.json(validResponse)
                      break
                    }
                  }
                } else {
                  // For stream mode, send event to all active connections
                  for (const [, response] of session.responses) {
                    sendSSEEvent(response, sessionId, validResponse)
                  }
                }
              }
            } else {
              // Ensure we have a complete and valid JSON-RPC notification
              const validNotification = {
                jsonrpc: '2.0',
                ...(jsonMsg.method ? { method: jsonMsg.method } : {}),
                ...(jsonMsg.params ? { params: jsonMsg.params } : {}),
              }

              // Broadcast notifications to all clients for this session
              for (const [, response] of session.responses) {
                sendSSEEvent(response, sessionId, validNotification)
              }
            }
          } catch (err) {
            logger.error(`Failed to send to session ${sessionId}:`, err)
          }
        }
      } catch (err) {
        logger.error(`Child non-JSON: ${line}, Error: ${err}`)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}
