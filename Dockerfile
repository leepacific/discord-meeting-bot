FROM node:22-slim

# ffmpeg 필요 + @snazzah/davey 네이티브 바이너리 지원
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 설치 (캐시 레이어 활용)
COPY package.json package-lock.json* ./
RUN npm install --production

# 소스 복사
COPY . .

CMD ["node", "index.js"]
