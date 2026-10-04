# 水质实验室样本分装与混样溯源工作台
# 使用完整版 node:20 镜像，确保 better-sqlite3 原生模块可直接编译/安装。
FROM node:20-bookworm

WORKDIR /app

# 先拷贝依赖清单并安装（利用镜像层缓存）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用源码与前端页面
COPY server.js ./
COPY public ./public

ENV PORT=3000
# 数据库文件位置（Compose 中挂载 named volume 持久化）
ENV DB_PATH=/app/data/lab.db

EXPOSE 3000

# 启动时：确保依赖就绪（首次或依赖变更时安装），随后启动服务；
# 服务启动时自动建表，数据库为空时写入示例数据。
CMD ["sh", "-c", "npm install --omit=dev --no-audit --no-fund && node server.js"]
