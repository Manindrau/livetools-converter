FROM node:24-bookworm

# Deployed Git SHA baked at build time (passed via --build-arg GIT_SHA=$(git rev-parse HEAD))
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    fonts-liberation \
    fonts-dejavu-core \
    ghostscript \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Debian 12 marks the system interpreter externally managed (PEP 668);
# --break-system-packages is required to install the runtime libraries.
RUN pip3 install --no-cache-dir --break-system-packages pdf2docx PyMuPDF==1.24.3 python-docx

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /tmp/uploads

EXPOSE 3000

CMD ["node", "server.js"]
