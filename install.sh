#!/bin/bash

# 确保以 root 运行
if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行此脚本！"
  exit 1
fi

# 更新系统包列表
echo "正在更新系统包列表..."
apt-get update -qq

# 安装基础依赖 + Node.js 和 npm
echo "安装基础依赖和Node.js..."
apt-get install -y -qq \
  curl \
  wget \
  git \
  build-essential \
  libssl-dev \
  ca-certificates \
  gnupg \
  unzip \
  nodejs \
  npm

# 安装 Yarn 和 PM2
echo "安装全局npm包..."
npm install -g yarn pm2

# 关闭防火墙
echo "关闭防火墙..."
ufw disable

# 进入项目目录并安装依赖
echo "安装项目依赖..."
cd secretChat && yarn

# 启动项目
echo "启动项目..."
pm2 start hack-server.js

echo "安装完成！"