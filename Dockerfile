# Use Node.js LTS (Long Term Support) version
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build arguments with defaults
ARG NODE_ENV=production
ARG PORT=3003
ARG MONGODB_URI=mongodb://mongo:27017/telephony-app
ARG BASE_URL=http://localhost:3003
ARG TELNYX_API_KEY
ARG TELNYX_CONNECTION_ID
ARG TELNYX_MESSAGING_PROFILE_ID

# Set environment variables
ENV NODE_ENV=$NODE_ENV
ENV PORT=$PORT
ENV MONGODB_URI=$MONGODB_URI
ENV BASE_URL=$BASE_URL
ENV TELNYX_API_KEY=$TELNYX_API_KEY
ENV TELNYX_CONNECTION_ID=$TELNYX_CONNECTION_ID
ENV TELNYX_MESSAGING_PROFILE_ID=$TELNYX_MESSAGING_PROFILE_ID

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose the port the app runs on
EXPOSE $PORT

# Start the application
CMD ["npm", "start"] 