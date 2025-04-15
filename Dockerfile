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

ENV MONGODB_URI="mongodb://harx:gcZ62rl8hoME@185.137.122.3:27017/V25_CompanySearchWizard"


# Start the app
CMD ["npm", "start"]
