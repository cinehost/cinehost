FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/player/package.json packages/player/
COPY packages/collector/package.json packages/collector/
RUN npm install --workspaces --include-workspace-root
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg does the transcode; the uploader UI depends on it being present.
RUN apk add --no-cache ffmpeg
COPY package.json ./
COPY packages/collector/package.json packages/collector/
RUN npm install --omit=dev --workspace @cinehost/collector --include-workspace-root
COPY bin ./bin
COPY db ./db
COPY packages/collector ./packages/collector
COPY --from=build /app/packages/player/dist ./packages/player/dist
# Generated, git-ignored assets live only in the build stage.
COPY --from=build /app/packages/collector/public/app/app.css ./packages/collector/public/app/app.css
EXPOSE 8080
# Migrations are idempotent and take milliseconds; running them on boot keeps
# a single-box deploy to one command.
CMD ["sh", "-c", "node bin/migrate.js && node packages/collector/src/index.js"]
