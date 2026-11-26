FROM python:3.12.11-slim-bookworm

# The base image ships empty __pycache__ directories. Compile the standard
# library once here so every test does not recompile json, re, enum, and other
# imports inside the 0.25 vCPU container.
RUN python -m compileall -q /usr/local/lib/python3.12 \
    && test -n "$(find /usr/local/lib/python3.12 -name '*.pyc' -print -quit)"

RUN groupadd --system --gid 10001 runner \
    && useradd --system --uid 10001 --gid runner --home-dir /tmp --shell /usr/sbin/nologin runner

WORKDIR /opt/runner
COPY runner.py submission_child.py /opt/runner/

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"]

ENTRYPOINT ["python", "-I", "-B", "/opt/runner/runner.py", "--serve", "--port", "8080"]
