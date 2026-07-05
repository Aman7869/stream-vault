FROM node:20-alpine

# Install system packages required by your application
RUN apk add --no-cache python3 make g++ ffmpeg

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source
COPY . .

# Production environment
ENV NODE_ENV=production

# Render provides the PORT environment variable
EXPOSE 5000

# Start the application
CMD ["npm", "start"]