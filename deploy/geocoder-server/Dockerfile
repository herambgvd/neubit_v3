# Offline address geocoder.
#
# Photon (komoot) over a prebuilt OpenStreetMap index. Street- and building-level
# search — "Star Tower Sector 30 Gurgaon" — with NOTHING leaving the box: the
# index is a file on disk, not an API call to anyone.
#
# It is the counterpart to the `tiles` service. Same shape on purpose: an image
# with no data in it, a bind-mounted /data, and an entrypoint that can provision
# itself on first start so `docker compose up` is the whole instruction.
#
# PHOTON IS PINNED TO 0.7.4, and not to the newer 1.x, because of the INDEX
# FORMAT. Photon 1.x reads an OpenSearch index; 0.7.x reads an Elasticsearch one.
# graphhopper publishes per-country extracts in the Elasticsearch format only —
# the OpenSearch build exists for the planet (~75 GB) and nothing smaller. Point
# 1.x at a country extract and it exits with "OpenSearch database not found",
# which is how this was found: by running it, not by reading release notes.
# Before raising the major, check that a country extract in the new format exists.
FROM eclipse-temurin:21-jre-alpine

# curl + bzip2 for the self-provisioning path; tar is already in busybox.
RUN apk add --no-cache curl bzip2

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# GEOCODER_COUNTRY picks the extract. "in" is India; graphhopper publishes one per
# ISO country code, and photon-db-planet-latest is the whole world (~75 GB).
ENV GEOCODER_DIR=/data \
    GEOCODER_COUNTRY=in \
    GEOCODER_PHOTON_VERSION=0.7.4 \
    GEOCODER_AUTO_PROVISION=1 \
    GEOCODER_PORT=2322

EXPOSE 2322
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
