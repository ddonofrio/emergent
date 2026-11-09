# Production deployment

Emergent is deployed to `http://74.208.72.196/emergent/` by the GitHub Actions workflow in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Every push to `main` verifies, packages, and deploys the committed revision.

## Security boundary

No password, private SSH key, provider token, or API key belongs in the repository.

- `SSH_PRIVATE_KEY` exists only as an encrypted GitHub Actions secret in `ddonofrio/emergent`.
- The server stores only the matching public key in `/home/guile/.ssh/authorized_keys`.
- Model credentials saved through the application live in `/var/lib/emergent/inference-config.json` on the server.
- Optional environment credentials belong in `/etc/emergent/emergent.env` on the server. That file is not part of a release.
- `.env`, `data/`, and private key files remain excluded from version control.

The server address, SSH port, remote user, public URL, service name, and filesystem paths are infrastructure identifiers rather than authentication credentials. They may appear in deployment configuration.

## Runtime layout

| Component | Location or value |
| --- | --- |
| Public application | `http://74.208.72.196/emergent/` |
| Node listener | `127.0.0.1:3000` |
| Releases | `/var/www/emergent/releases/<commit-sha>` |
| Active release | `/var/www/emergent/current` symlink |
| Persistent data | `/var/lib/emergent` |
| Optional environment file | `/etc/emergent/emergent.env` |
| Systemd unit | `/etc/systemd/system/emergent.service` |
| Nginx site | `/etc/nginx/sites-available/emergent-ip` |
| Deployment user | `guile` |
| SSH endpoint | `74.208.72.196:22022` |

The systemd service runs as `guile`, binds only to loopback, starts after boot, and restarts after a process failure. Persistent world data is outside release directories, so code deployments do not replace recordings or model configuration.

## GitHub Actions secrets

The repository requires these Actions secrets:

| Secret | Purpose |
| --- | --- |
| `SSH_PRIVATE_KEY` | Private half of the dedicated Emergent deployment key |
| `SSH_KNOWN_HOSTS` | Pinned ED25519 host key for `[74.208.72.196]:22022` |
| `SERVER_HOST` | SSH server address |
| `SERVER_PORT` | SSH port |
| `SERVER_USER` | Remote deployment user |
| `REMOTE_PATH` | Absolute release root, `/var/www/emergent` |
| `DEPLOY_URL` | Public smoke-test URL |

GitHub does not expose secret values after storage. Rotating the deployment key means adding the new public key to the server, replacing `SSH_PRIVATE_KEY`, completing one successful deployment, and then removing the old public key.

## Deployment lifecycle

The workflow performs these steps:

1. Check out the pushed commit and install the locked Node.js dependencies.
2. Run the complete test suite.
3. Build the browser application with `BASE_PATH=/emergent/`.
4. Package the production bundle, server source, runtime source, vendored runtime, and package manifests.
5. Upload the package into an immutable directory named after the commit SHA.
6. Install the locked dependencies in that release.
7. Atomically switch `/var/www/emergent/current` and restart `emergent.service`.
8. Run the public smoke test.
9. Restore and restart the previous release automatically if the smoke test fails.
10. Retain the five newest releases while preserving the active release.

The deployment lock at `/var/www/emergent/.deploy-lock` prevents two releases from switching the service concurrently.

## Operations

Inspect the service and recent logs:

```sh
systemctl status emergent.service
sudo journalctl -u emergent.service -n 100 --no-pager
```

Validate Nginx before any reload:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Roll back to an existing release:

```sh
cd /var/www/emergent
ln -sfn releases/<commit-sha> .current-link
mv -Tf .current-link current
sudo systemctl restart emergent.service
```

Use a commit SHA already present under `/var/www/emergent/releases/`. Do not point `current` outside `/var/www/emergent`.

## IP virtual host

The IP virtual host serves Emergent only under `/emergent/`; the IP root returns `404`. The old Rocco Nginx site is disabled, and `/var/www/rocco` remains on disk but is not served. The Rocco GitHub workflow no longer contains a deployment job.
