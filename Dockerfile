#syntax=docker/dockerfile:1.28
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG GIT_TAG=unknown
ARG GIT_TREE_STATE=unknown
ARG BUILD_DATE=unknown

FROM golang:1.27.3-alpine3.23@sha256:8a5046497cda39860b832ffdbe8dd66018a0f05bb01352f533a36e7e2ced66a0 AS builder

RUN apk add --no-cache git make ca-certificates bash

WORKDIR /go/src/github.com/argoproj/argo-workflows
COPY go.mod .
COPY go.sum .
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .

####################################################################################################

FROM node:24-alpine3.23@sha256:9b69af715c7f9d038150b54ccccbaeffa9064bbc93e2904c29591ca097316af1 AS argo-ui

RUN apk add --no-cache git

COPY ui/package.json ui/yarn.lock ui/

RUN --mount=type=cache,target=/root/.yarn \
  YARN_CACHE_FOLDER=/root/.yarn JOBS=max \
  yarn --cwd ui install --frozen-lockfile --network-timeout 1000000

COPY ui ui
COPY api api

RUN --mount=type=cache,target=/root/.yarn \
  YARN_CACHE_FOLDER=/root/.yarn JOBS=max \
  NODE_OPTIONS="--max-old-space-size=2048" JOBS=max yarn --cwd ui build

####################################################################################################

####################################################################################################

####################################################################################################

FROM builder AS argocli-build

ARG VERSION
ARG GIT_COMMIT
ARG GIT_TAG
ARG GIT_TREE_STATE
ARG BUILD_DATE

RUN mkdir -p ui/dist
COPY --from=argo-ui ui/dist/app ui/dist/app
# update timestamp so that `make` doesn't try to rebuild this -- it was already built in the previous stage
RUN touch ui/dist/app/index.html

RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 make dist/argo VERSION="$VERSION" BUILD_DATE="$BUILD_DATE" GIT_COMMIT="$GIT_COMMIT" GIT_TAG="$GIT_TAG" GIT_TREE_STATE="$GIT_TREE_STATE"

####################################################################################################

####################################################################################################

####################################################################################################
####################################################################################################

####################################################################################################

FROM gcr.io/distroless/static-debian13:latest@sha256:034df5c1737e8241f6ed6423a12e720ee0f6d6f088609ee172f98f6f2166ef5d AS argocli

USER 8737

WORKDIR /home/argo

COPY hack/ssh_known_hosts /etc/ssh/
COPY hack/nsswitch.conf /etc/
COPY --from=argocli-build /go/src/github.com/argoproj/argo-workflows/dist/argo /bin/

ENTRYPOINT [ "argo" ]

####################################################################################################

FROM argocli AS server
CMD [ "server" ]
