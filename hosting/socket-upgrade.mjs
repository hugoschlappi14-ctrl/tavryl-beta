// Reject incomplete upgrade attempts before opening a socket to the game.
// Real clients still use the standard WebSocket v13 handshake unchanged.
export function validUpgrade(headers) {
  const connection=String(headers.connection||'').toLowerCase().split(',').map(s=>s.trim());
  return String(headers.upgrade||'').toLowerCase()==='websocket'
    && connection.includes('upgrade')
    && headers['sec-websocket-version']==='13'
    && /^[A-Za-z0-9+/]{22}==$/.test(String(headers['sec-websocket-key']||''));
}
