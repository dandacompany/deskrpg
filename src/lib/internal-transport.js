const INTERNAL_SECRET_HEADER = "x-deskrpg-internal-secret";

function getInternalSocketHostname(env = process.env) {
  return env.INTERNAL_HOSTNAME || "127.0.0.1";
}

function getInternalSocketPort(env = process.env) {
  return (parseInt(env.PORT || "3000", 10) + 1).toString();
}

function getInternalSocketBaseUrl(env = process.env) {
  return `http://${getInternalSocketHostname(env)}:${getInternalSocketPort(env)}`;
}

function getInternalSecret(env = process.env) {
  return env.INTERNAL_RPC_SECRET || env.JWT_SECRET || "";
}

function buildInternalAuthHeaders(secret = getInternalSecret()) {
  return secret ? { [INTERNAL_SECRET_HEADER]: secret } : {};
}

function readHeader(headers, headerName) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(headerName);
  const lowered = headerName.toLowerCase();
  if (typeof headers[headerName] === "string") return headers[headerName];
  if (typeof headers[lowered] === "string") return headers[lowered];
  return null;
}

function isInternalRequestAuthorized(headers, secret = getInternalSecret()) {
  if (!secret) return false;
  return readHeader(headers, INTERNAL_SECRET_HEADER) === secret;
}

module.exports = {
  INTERNAL_SECRET_HEADER,
  buildInternalAuthHeaders,
  getInternalSecret,
  getInternalSocketBaseUrl,
  getInternalSocketHostname,
  getInternalSocketPort,
  isInternalRequestAuthorized,
};
