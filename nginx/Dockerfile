# Dockerfile.nginx
FROM nginx:latest

# Установка зависимостей для сборки модуля
RUN apt-get update && apt-get install -y \
    git \
    wget \
    build-essential \
    libpcre3-dev \
    zlib1g-dev \
    libssl-dev

# Клонирование и сборка модуля sticky
RUN cd /tmp && \
    git clone https://github.com/Refinitiv/nginx-sticky-module-ng.git && \
    wget http://nginx.org/download/nginx-1.25.3.tar.gz && \
    tar -xvzf nginx-1.25.3.tar.gz && \
    cd nginx-1.25.3 && \
    ./configure --add-module=/tmp/nginx-sticky-module-ng && \
    make && make install

# Копирование конфигурации
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 4000
CMD ["nginx", "-g", "daemon off;"]