FROM node:20-slim

# Install ffmpeg for video conversion
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --production

# Install dashboard dependencies and build
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm ci

COPY dashboard/ ./dashboard/
RUN cd dashboard && npm run build

# Copy server source and guest page
COPY server/ ./server/
COPY guest/ ./guest/

# Copy root files
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
