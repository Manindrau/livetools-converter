FROM node:18-bullseye

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

RUN pip3 install pdf2docx PyMuPDF==1.24.3 python-docx

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /tmp/uploads

EXPOSE 3000

CMD ["node", "server.js"]
