# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.26.11-trixie@sha256:f9e99477a80ccd7adfb69780510b22c7249ce9169885f18aa762cd886e75e018
ARG RUNTIME_IMAGE=debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
ARG DEBIAN_SNAPSHOT=20261125T000000Z
ARG PDFIUM_VERSION=chromium/8179
ARG PDFIUM_SHA256_ARM64=18bb6d568257b28d14f6c3b8bfb48caf73d4615b319ca4d43b424c2a03431d9f
ARG PDFIUM_SHA256_X64=b4766a6bf2856efbcc6c3cc7d6ae9022bdc6bb36ddc1acdd92d1f1873f773f4b

FROM ${GO_IMAGE} AS build
ARG DEBIAN_SNAPSHOT
ARG PDFIUM_VERSION
ARG PDFIUM_SHA256_ARM64
ARG PDFIUM_SHA256_X64
ARG TARGETARCH
RUN printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && rm -f /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install --yes --no-install-recommends gcc libc6-dev libwebp-dev \
 && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH}" in arm64) arch=arm64; sha="${PDFIUM_SHA256_ARM64}" ;; amd64) arch=x64; sha="${PDFIUM_SHA256_X64}" ;; *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL "https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_VERSION}/pdfium-linux-${arch}.tgz" -o /tmp/pdfium.tgz \
 && echo "${sha}  /tmp/pdfium.tgz" | sha256sum --check --strict \
 && mkdir -p /pdfium /src/native/pdfium/include /src/native/pdfium/lib \
 && tar -xzf /tmp/pdfium.tgz -C /pdfium \
 && cp -R /pdfium/include/. /src/native/pdfium/include/ \
 && cp /pdfium/lib/libpdfium.so /src/native/pdfium/lib/
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=1 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /out/bootstrap ./cmd/renderer

FROM ${RUNTIME_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT
RUN printf 'path-exclude=/usr/share/doc/*\npath-exclude=/usr/share/man/*\npath-exclude=/usr/share/info/*\npath-exclude=/usr/share/locale/*\npath-include=/usr/share/locale/en*\n' > /etc/dpkg/dpkg.cfg.d/01-slim \
 && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s/\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "${DEBIAN_SNAPSHOT}" "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates libwebp7 libsharpyuv0 \
      libreoffice-impress libreoffice-writer libreoffice-calc python3-uno \
      fonts-noto-core fonts-noto-cjk fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core fontconfig \
 && find /usr/share/fonts/opentype/noto -type f ! -name 'NotoSansCJK-Regular.ttc' ! -name 'NotoSerifCJK-Regular.ttc' -delete \
 && fc-cache -f \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/debconf/* /var/cache/ldconfig/aux-cache /var/log/* /usr/share/lintian /usr/share/bug /usr/lib/python3/dist-packages/__pycache__ \
 && mkdir -p /opt/renderer/lib /opt/renderer/licenses \
 && dpkg-query -W -f='${Package}=${Version}\n' | sort > /opt/renderer/packages.txt \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin renderer
COPY --from=build /out/bootstrap /opt/renderer/bootstrap
COPY --from=build /src/native/pdfium/lib/libpdfium.so /opt/renderer/lib/libpdfium.so
COPY --from=build /pdfium/LICENSE /pdfium/licenses /opt/renderer/licenses/pdfium/
COPY office/office_convert.py /opt/renderer/office-convert.py
RUN chmod 0755 /opt/renderer/bootstrap && chmod 0644 /opt/renderer/lib/libpdfium.so /opt/renderer/office-convert.py
ENV LD_LIBRARY_PATH=/opt/renderer/lib \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    RENDERER_SOFFICE=/usr/bin/soffice RENDERER_KEYNOTE=1 \
    RENDERER_OFFICE_DRIVER=/opt/renderer/office-convert.py
USER 10001:10001
ENTRYPOINT ["/opt/renderer/bootstrap"]
