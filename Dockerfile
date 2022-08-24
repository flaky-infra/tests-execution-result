FROM node:alpine

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

# CMD ["node", "dist/index.js"]
CMD ["npm", "start"]