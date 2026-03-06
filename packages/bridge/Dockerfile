FROM debian:bookworm-slim
COPY dist/relay-bridge-linux /usr/local/bin/relay-bridge
RUN chmod +x /usr/local/bin/relay-bridge
VOLUME /root/.relay-bridge
EXPOSE 8333 9333
ENTRYPOINT ["relay-bridge"]
CMD ["start"]
