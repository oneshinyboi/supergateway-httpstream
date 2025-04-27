FROM node:20-alpine

# Install Python 3, pip, and build dependencies needed for Python extensions
RUN apk add --no-cache python3 py3-pip gcc musl-dev python3-dev

# Install uv - a fast Python package installer and runner
RUN python3 -m pip install uv

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source files and build
COPY . .
RUN npm run build

# Make sure Python and uv are in the PATH
ENV PATH="/usr/bin:${PATH}"

EXPOSE 8000

# Run using the local build
ENTRYPOINT ["node", "dist/index.js"]

CMD ["--help"]
