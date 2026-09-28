import { pathToFileURL } from 'node:url'

const { ACPServer } = await import(pathToFileURL(process.argv[2]).href)
const server = new ACPServer({}, { cwd: process.cwd() })
server.start()
