/* eslint-disable no-console */
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createConnection } from 'node:net';

const [controlHost, controlPortText, username, password, targetHost, targetPortText] =
    process.argv.slice(2);
const controlPort = Number(controlPortText);
const targetPort = Number(targetPortText);

class Reader {
    buffer = Buffer.alloc(0);
    pending = [];

    constructor(socket) {
        socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            while (this.pending.length && this.buffer.length >= this.pending[0].length) {
                const pending = this.pending.shift();
                pending.resolve(this.take(pending.length));
            }
        });
        socket.on('error', (error) => {
            for (const pending of this.pending.splice(0)) pending.reject(error);
        });
    }

    read(length) {
        if (this.buffer.length >= length) return Promise.resolve(this.take(length));
        return new Promise((resolve, reject) => this.pending.push({ length, resolve, reject }));
    }

    take(length) {
        const result = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return result;
    }
}

const readAddress = async (reader, atyp) => {
    if (atyp === 1) return Array.from(await reader.read(4)).join('.');
    if (atyp === 3) {
        const length = (await reader.read(1))[0];
        return (await reader.read(length)).toString();
    }
    if (atyp === 4) {
        const value = await reader.read(16);
        return Array.from({ length: 8 }, (_, index) =>
            value.readUInt16BE(index * 2).toString(16),
        ).join(':');
    }
    throw new Error(`Unsupported SOCKS address type ${atyp}`);
};

const main = async () => {
    const tcp = createConnection({ host: controlHost, port: controlPort });
    await once(tcp, 'connect');
    tcp.setTimeout(5_000, () => tcp.destroy(new Error('SOCKS control timeout')));
    const reader = new Reader(tcp);
    tcp.write(Buffer.from([5, 1, 2]));
    if (!(await reader.read(2)).equals(Buffer.from([5, 2]))) {
        throw new Error('SOCKS server did not require username/password');
    }
    const user = Buffer.from(username);
    const pass = Buffer.from(password);
    tcp.write(
        Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
    );
    if (!(await reader.read(2)).equals(Buffer.from([1, 0]))) throw new Error('SOCKS auth failed');

    tcp.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
    const reply = await reader.read(4);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`UDP ASSOCIATE failed: ${reply[1]}`);
    const relayAddress = await readAddress(reader, reply[3]);
    const relayPort = (await reader.read(2)).readUInt16BE(0);
    const effectiveRelayAddress =
        relayAddress === '0.0.0.0' || relayAddress === '::' ? controlHost : relayAddress;

    const target = Buffer.from(targetHost);
    const payload = Buffer.from(`remnawave-udp-${process.pid}`);
    const packet = Buffer.concat([
        Buffer.from([0, 0, 0, 3, target.length]),
        target,
        Buffer.from([targetPort >> 8, targetPort & 0xff]),
        payload,
    ]);
    const udp = createSocket(effectiveRelayAddress.includes(':') ? 'udp6' : 'udp4');
    const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('UDP relay reply timeout')), 2_000);
        udp.once('message', (message) => {
            clearTimeout(timeout);
            resolve(message);
        });
        udp.once('error', reject);
    });
    udp.send(packet, relayPort, effectiveRelayAddress);
    const response = await received;
    udp.close();
    tcp.destroy();
    if (!response.subarray(-payload.length).equals(payload))
        throw new Error('UDP payload mismatch');
    console.log(JSON.stringify({ relayAddress, relayPort, effectiveRelayAddress }));
};

void main();
