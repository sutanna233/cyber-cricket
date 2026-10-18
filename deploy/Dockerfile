# 赛博斗蛐蛐 · Node 镜像（纯静态 + 一个无状态认证服务，无第三方依赖）
FROM node:22-alpine

WORKDIR /app
COPY . /app

# 只暴露运行必需的目录（镜像层面再收一道）
RUN rm -rf /app/tools /app/tests /app/docs /app/shots /app/.git /app/__pycache__ || true

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8130 \
    CC_MODE=view

EXPOSE 8130

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8130)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
