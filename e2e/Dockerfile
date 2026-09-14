FROM alpine:3.20

RUN apk add --no-cache \
    openssh-server \
    openssh-sftp-server \
    bash \
  && ssh-keygen -A \
  && adduser -D -h /home/deploy -s /bin/sh deploy \
  && passwd -u deploy \
  && mkdir -p /home/deploy/www /home/deploy/.ssh \
  && chown -R deploy:deploy /home/deploy

COPY sshd_config /etc/ssh/sshd_config
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
