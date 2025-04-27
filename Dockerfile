FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source files and build
COPY . .
RUN npm run build

EXPOSE 8000

# Run using the local build
ENTRYPOINT ["node", "dist/index.js"]

CMD ["--help"]
