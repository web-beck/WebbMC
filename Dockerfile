# WebbMC for Railway (or any Docker host).
# Node.js runs the panel; Java 25 is the default, with 21 and 17 for older Minecraft versions.
# Build from the repository root, which is what Railway uses:
#   docker build -t webbmc .
FROM eclipse-temurin:17-jre-noble AS java17
FROM eclipse-temurin:21-jre-noble AS java21
FROM node:24-bookworm-slim AS node

FROM eclipse-temurin:25-jre-noble
COPY --from=java17 /opt/java/openjdk /opt/java/17
COPY --from=java21 /opt/java/openjdk /opt/java/21
RUN ln -s /opt/java/openjdk /opt/java/25
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY . ./
# Fail early, with a listing, if the build context is missing part of the panel.
RUN test -f server.js && test -f index.html && test -f lib/manager.js && test -f static/app.js \
    || (echo "WebbMC files are missing from the build context. Contents of /app:" && ls -laR /app && exit 1)

# Data goes to the Railway volume when one is attached (RAILWAY_VOLUME_MOUNT_PATH), otherwise /app/data.
ENV NODE_ENV=production \
    WEBMC_HOST=0.0.0.0 \
    WEBMC_JAVA_PATHS=/opt/java/25/bin/java,/opt/java/21/bin/java,/opt/java/17/bin/java

EXPOSE 8420 25565
CMD ["node", "server.js"]
