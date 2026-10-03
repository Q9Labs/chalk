"""Private, fixed-object guest evidence transport; no guest AWS credentials."""
import base64
import hashlib
import hmac
import json
import shlex
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlencode


def presigned_put(bucket, key, region, credentials, expires, now=None):
    now = now or datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    day = now.strftime("%Y%m%d")
    scope = f"{day}/{region}/s3/aws4_request"
    host = f"{bucket}.s3.{region}.amazonaws.com"
    path = "/" + quote(key, safe="/~")
    parameters = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": credentials["AccessKeyId"] + "/" + scope,
                  "X-Amz-Date": stamp, "X-Amz-Expires": str(expires), "X-Amz-SignedHeaders": "host"}
    # Fixed AWS credential-process JSON field, at this provider adapter seam.
    if credentials.get("SessionToken"):
        parameters["X-Amz-Security-Token"] = credentials["SessionToken"]
    query = urlencode(sorted(parameters.items()), quote_via=quote, safe="~")
    canonical = f"PUT\n{path}\n{query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD"
    signing = ("AWS4" + credentials["SecretAccessKey"]).encode()
    for part in (day, region, "s3", "aws4_request"):
        signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
    message = f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n" + hashlib.sha256(canonical.encode()).hexdigest()
    signature = hmac.new(signing, message.encode(), hashlib.sha256).hexdigest()
    return f"https://{host}{path}?{query}&X-Amz-Signature={signature}"


def boot_command(collector, url, deadline, binding):
    program = collector + "\n" + '''
import time, urllib.request, traceback
URL = __URL__
DEADLINE = __DEADLINE__
BINDING = __BINDING__
while time.time() < DEADLINE:
    try:
        payload = json.dumps({"binding": BINDING, "collected_at": time.time(), **collect()}).encode()
        request = urllib.request.Request(URL, data=payload, method="PUT")
        with urllib.request.urlopen(request, timeout=20) as response:
            print("guest evidence uploaded", response.status, len(payload), flush=True)
    except Exception:
        traceback.print_exc()
    time.sleep(min(30, max(0, DEADLINE-time.time())))
'''.replace("__URL__", repr(url)).replace("__DEADLINE__", repr(deadline)).replace("__BINDING__", repr(binding))
    encoded = base64.b64encode(program.encode()).decode()
    python = "import base64; exec(base64.b64decode(" + repr(encoded) + "))"
    return ["/bin/sh", "-c", "nohup /usr/bin/python3 -c " + shlex.quote(python) +
            " </dev/null >/var/log/chalk-boot-evidence.log 2>&1 &"]


def clean_objects(services, state):
    bucket, key = state["evidence_bucket"], state["evidence_key"]
    if key != "bootdiag/" + state["name"] + "/guest.json":
        raise RuntimeError("guest evidence object ownership mismatch")
    # This bucket can be versioned: delete versions and markers, not just the current object.
    versions = services.aws("s3api", "list-object-versions", "--bucket", bucket, "--prefix", key)
    for entry in versions.get("Versions", []) + versions.get("DeleteMarkers", []):
        if entry["Key"] != key:
            raise RuntimeError("ambiguous guest evidence object prefix")
        services.aws("s3api", "delete-object", "--bucket", bucket, "--key", key, "--version-id", entry["VersionId"])
    services.aws("s3api", "delete-object", "--bucket", bucket, "--key", key)
    # The last DELETE may itself create a marker. Remove it too.
    remaining = services.aws("s3api", "list-object-versions", "--bucket", bucket, "--prefix", key)
    for entry in remaining.get("DeleteMarkers", []):
        if entry["Key"] != key:
            raise RuntimeError("ambiguous guest evidence deletion marker")
        services.aws("s3api", "delete-object", "--bucket", bucket, "--key", key, "--version-id", entry["VersionId"])
    final = services.aws("s3api", "list-object-versions", "--bucket", bucket, "--prefix", key)
    if final.get("Versions") or final.get("DeleteMarkers"):
        raise RuntimeError("guest evidence object cleanup unproved")
