# Use official Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Expose port
EXPOSE 3003

# Environment variables should be set in Railway, not hardcoded here
# Required environment variables:
# - MONGODB_URI
# - PORT
# - NODE_ENV
# - TELNYX_API_KEY
# - TELNYX_PUBLIC_KEY
# - TELNYX_CONNECTION_ID
# - TELNYX_APPLICATION_ID
# - TWILIO_ACCOUNT_SID
# - TWILIO_AUTH_TOKEN
# - BASE_URL

# Start the app
CMD ["npm", "start"]
