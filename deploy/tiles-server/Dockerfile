# Offline basemap tile server.
#
# nginx serving the PMTiles world archive over HTTP range requests, plus the
# pmtiles CLI so the container can BUILD that archive itself on first start.
# That is the whole point of this image: `docker compose up` provisions the map,
# with no separate command for an operator to remember or forget.
FROM protomaps/go-pmtiles:v1.31.2 AS pmtiles

FROM nginx:1.27-alpine

# The upstream image is `scratch` with a single static Go binary — nothing else to
# copy, and nothing in it to keep patched.
COPY --from=pmtiles /go-pmtiles /usr/local/bin/pmtiles

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Where the archive lives. Bind-mounted to deploy/tiles/ so a pre-built archive
# can simply be dropped in on an air-gapped host.
ENV TILES_DIR=/data \
    TILES_SOURCE=https://data.source.coop/protomaps/openstreetmap/v4.pmtiles \
    TILES_MAXZOOM=10

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
