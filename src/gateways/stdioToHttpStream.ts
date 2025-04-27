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

      // For initialize requests in batch mode, we need a special handling approach
      if (responseMode === 'batch') {
        const requestId = message.id.toString()

        // Critical debugging info
        logger.info(
          `Setting up init request with ID ${requestId} in session ${sessionId}`,
        )

        // VERY IMPORTANT: Store this request in the pending requests map
        sessions[sessionId].pendingRequests.set(requestId, message)

        // VERY IMPORTANT: Store the response object in the responses map with the request ID as the key
        // This is so we can find it later when the child process responds
        sessions[sessionId].responses.set(requestId, res)

        // Log the current state for debugging
        logger.info(
          `Session ${sessionId} now has ${sessions[sessionId].pendingRequests.size} pending requests`,
        )
        logger.info(
          `Session ${sessionId} now has ${sessions[sessionId].responses.size} stored responses`,
        )

        // Send message to child process
        child.stdin.write(JSON.stringify(message) + '\n')

        // Handle client disconnect
        req.on('close', () => {
          if (sessions[sessionId]) {
            logger.info(`Client disconnected for request ${requestId}`)
            sessions[sessionId].responses.delete(requestId)
            sessions[sessionId].pendingRequests.delete(requestId)
          }
        })

        // Set up timeout for the initialize request
        setTimeout(() => {
          if (res.writableEnded) return

          // If the request is still pending, it timed out
          if (sessions[sessionId]?.pendingRequests.has(requestId)) {
            sessions[sessionId].pendingRequests.delete(requestId)
            sessions[sessionId].responses.delete(requestId)

            logger.error(`Initialize request timed out after ${batchTimeout}ms`)
            res.setHeader('Content-Type', 'application/json')
            return res.status(504).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Initialize request timeout',
              },
              id: message.id,
            })
          }
        }, batchTimeout)

        // Return without sending a response yet - it will be sent when the child process responds
        return
      }
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

        // Add this response to the session's responses
        // This is critical for the child process output handler to find this response
        // when it needs to send the response back to the client
        sessions[sessionId].responses.set(requestId, res)

        // Handle client disconnect
        req.on('close', () => {
          if (sessions[sessionId]) {
            sessions[sessionId].responses.delete(requestId)
            // Also remove the pending request to avoid memory leaks
            sessions[sessionId].pendingRequests.delete(requestId)
          }
        })

        // Set up the timeout to send batch response
        setTimeout(() => {
          if (res.writableEnded) return

          // If no response was sent yet, send error
          if (sessions[sessionId]?.pendingRequests.has(requestId)) {
            sessions[sessionId].pendingRequests.delete(requestId)
            sessions[sessionId].responses.delete(requestId)

            // Make sure we set the content type header
            res.setHeader('Content-Type', 'application/json')

            // Send timeout error as a proper JSON-RPC response
            const timeoutResponse = {
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Request timeout',
              },
              id: message.id,
            }
            res.status(504).json(timeoutResponse)
            logger.error(
              `Request ${requestId} timed out after ${batchTimeout}ms`,
            )
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
        logger.info('Child → HTTP:', JSON.stringify(jsonMsg))

        // Process response for all active sessions
        for (const [sessionId, session] of Object.entries(sessions)) {
          try {
            // If this is a response to a specific request
            if (jsonMsg.id !== undefined) {
              const requestId = jsonMsg.id.toString()
              logger.info(
                `Processing response for request ${requestId} in session ${sessionId}`,
              )

              // Debug session state
              logger.info(
                `Session ${sessionId} has ${session.pendingRequests.size} pending requests`,
              )
              logger.info(
                `Session ${sessionId} has ${session.responses.size} stored responses`,
              )

              // Get this specific response object directly by request ID
              // This is critical for initialize requests
              const directResponse = session.responses.get(requestId)

              if (directResponse && !directResponse.writableEnded) {
                // This is the direct response object for this specific request
                logger.info(
                  `Found direct response object for request ${requestId}`,
                )

                // Get the original pending request if available
                const pendingRequest = session.pendingRequests.get(requestId)

                // Delete the request from pending regardless of what happens next
                session.pendingRequests.delete(requestId)
                session.responses.delete(requestId)

                // Ensure we have a complete and valid JSON-RPC response
                const validResponse = {
                  jsonrpc: '2.0',
                  result: jsonMsg.result !== undefined ? jsonMsg.result : null,
                  error: jsonMsg.error || null,
                  id: jsonMsg.id,
                }

                // Remove null properties
                if (validResponse.error === null) delete validResponse.error

                // Special logging for initialize responses
                if (
                  pendingRequest &&
                  'method' in pendingRequest &&
                  pendingRequest.method === 'initialize'
                ) {
                  logger.info(
                    `Sending initialize response for session ${sessionId}`,
                  )
                }

                // CRITICAL: Make sure we set the Content-Type header
                directResponse.setHeader('Content-Type', 'application/json')

                const responseString = JSON.stringify(validResponse)
                logger.info(`Sending direct response: ${responseString}`)

                // Send the response
                directResponse.status(200).send(responseString)

                // We've handled this response
                continue
              }

              // If we don't have a direct response, try to find the pending request
              const pendingRequest = session.pendingRequests.get(requestId)
              if (pendingRequest) {
                session.pendingRequests.delete(requestId)
                logger.info(
                  `Found pending request for ${requestId}, looking for response handler`,
                )

                // Ensure we have a complete and valid JSON-RPC response
                const validResponse = {
                  jsonrpc: '2.0',
                  result: jsonMsg.result !== undefined ? jsonMsg.result : null,
                  error: jsonMsg.error || null,
                  id: jsonMsg.id,
                }

                // Remove null properties
                if (validResponse.error === null) delete validResponse.error

                // Find if there's a response handler for this request
                if (responseMode === 'batch') {
                  // For batch mode responses
                  let sentResponse = false

                  // Try to find any active response handler
                  for (const [responseId, response] of session.responses) {
                    if (!response.writableEnded) {
                      logger.info(
                        `Sending batch response using response ${responseId} for request ${requestId}`,
                      )

                      // Set the content type header
                      response.setHeader('Content-Type', 'application/json')

                      const responseString = JSON.stringify(validResponse)
                      logger.info(`Response payload: ${responseString}`)

                      // Send the response
                      response.status(200).send(responseString)
                      sentResponse = true
                      break
                    }
                  }

                  if (!sentResponse) {
                    ;(logger.warn || logger.error)(
                      `No active response handler found for request ${requestId} in session ${sessionId}`,
                    )
                  }
                } else {
                  // For stream mode, send event to all active connections
                  for (const [, response] of session.responses) {
                    sendSSEEvent(response, sessionId, validResponse)
                  }
                }
              } else {
                ;(logger.warn || logger.error)(
                  `No pending request found for ID ${requestId} in session ${sessionId}`,
                )
              }
            } else {
              // Ensure we have a complete and valid JSON-RPC notification
              const validNotification = {
                jsonrpc: '2.0',
                method: jsonMsg.method || '',
                params: jsonMsg.params || null,
              }

              // Remove null properties
              if (validNotification.params === null)
                delete validNotification.params

              // Broadcast notifications to all clients for this session
              for (const [, response] of session.responses) {
                sendSSEEvent(response, sessionId, validNotification)
              }
            }
          } catch (error) {
            const err = error as Error
            logger.error(`Failed to send to session ${sessionId}:`, err)
            logger.error(err.stack || err.message || String(err))
          }
        }
      } catch (error) {
        const err = error as Error
        logger.error(`Child non-JSON: ${line}, Error: ${String(err)}`)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}
