// On Deno (Supabase Edge Functions) WebSocket is built in, so the Node "ws"
// package is replaced with the native one.
export default globalThis.WebSocket
