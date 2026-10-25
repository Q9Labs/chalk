set -eu
sudo -u '#1000' env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart chalk-api.service
curl --fail --silent --show-error http://127.0.0.1:18080/readyz
