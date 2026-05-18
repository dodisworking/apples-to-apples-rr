# Apples to Apples — Node 20 + LibreOffice for XLSX → PDF rendering.
#
# LibreOffice is installed at build time so the reviewer can render uploaded
# Argus XLSX files as actual Excel-style pages (via libreoffice-convert →
# soffice headless) and ship them through pdf.js alongside the client PDF.

FROM node:20-slim

# LibreOffice + Java JRE (soffice's javaldx needs Java to function correctly).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-core \
      libreoffice-calc \
      libreoffice-writer \
      libreoffice-common \
      libreoffice-java-common \
      default-jre-headless \
      fonts-liberation \
      fonts-dejavu \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better Docker cache hits
COPY package*.json ./
RUN npm install --omit=dev

# Then the rest of the source
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
