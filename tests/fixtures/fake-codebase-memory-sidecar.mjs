import { createServer } from 'node:http'

const portArgument = process.argv.find((argument) => argument.startsWith('--port='))
const port = Number(portArgument?.slice('--port='.length))
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('fake graph')
})

server.listen(port, '127.0.0.1')
process.stdin.resume()
process.once('SIGTERM', () => server.close(() => process.exit(0)))
