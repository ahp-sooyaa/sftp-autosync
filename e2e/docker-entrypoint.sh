#!/bin/sh
set -e

mkdir -p /home/deploy/.ssh /home/deploy/www
chmod 700 /home/deploy/.ssh

if [ -f /run/keys/authorized_keys ]; then
  cp /run/keys/authorized_keys /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
  chown -R deploy:deploy /home/deploy/.ssh
fi

chown -R deploy:deploy /home/deploy/www

exec "$@"
