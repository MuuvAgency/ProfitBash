# Railway-Cron-Service `db-backup` (docs/deploy.md): pg_dump 17 aus dem offiziellen Image, dazu age und curl.
# pg_dump muss mindestens die Hauptversion des Railway-Postgres haben. Basis per Digest gepinnt; Updates bewusst.
FROM postgres:17.10-alpine3.24@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

RUN apk add --no-cache bash curl 'age~1.3'

COPY backup.sh restore-test.sh /usr/local/bin/

# Kein Postgres-Server: Das Entrypoint-Skript des Basis-Images wird nicht gebraucht.
USER postgres
ENTRYPOINT []
CMD ["backup.sh"]
