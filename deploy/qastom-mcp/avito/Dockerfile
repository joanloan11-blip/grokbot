FROM node:24-alpine
RUN npm install -g avito-mcp@2.1.1 && npm cache clean --force \
 && mkdir -p /home/node/.local/state && chown -R node:node /home/node/.local
USER node
ENV HOME=/home/node XDG_STATE_HOME=/home/node/.local/state NODE_ENV=production
CMD ["avito-mcp"]
