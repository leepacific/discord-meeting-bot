FROM node:20-slim

# ffmpeg만 필요 (네이티브 빌드 불필요 - opusscript/libsodium-wrappers 사용)
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
