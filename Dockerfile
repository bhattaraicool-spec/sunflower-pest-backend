FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

# /app/data is where submitted visits are persisted.
# Mount a Fly.io volume here to survive restarts.
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
