# 1.21.8-to-C0.30

**Minecraft 1.21.8 → C0.30 bridge**

Bridge between **Minecraft Java 1.21.8** and **ClassiCube C0.30**, written in **Node.js**.


## Installation

```cmd
git clone https://github.com/yzproject092-eng/1.21.8-to-C0.30
cd 1.21.8-to-C0.30
npm install
```

## Windows

Run in **CMD**:

```cmd
set MC_HOST=IP_OF_MINECRAFT_SERVER
set MC_PORT=25565
set BRIDGE_PASSWORD=None
set LISTEN_PORT=5000
node bridge.js
```

### Variables

| Variable          | Description                            |
| ----------------- | -------------------------------------- |
| `MC_HOST`         | IP of the Minecraft 1.21.8 server      |
| `MC_PORT`         | Minecraft server port, usually `25565` |
| `BRIDGE_PASSWORD` | Your client's `mppass`, or `None`      |
| `LISTEN_PORT`     | Port used by the bridge                |

If the bridge runs on the same server as Minecraft, use a different `LISTEN_PORT`, for example `5000`.

## Connect

After starting the bridge, connect to the bridge using **ClassiCube**.

See **[HOWtoCONNECT.jpg](https://github.com/yzproject092-eng/1.21.8-to-C0.30/blob/main/HOWtoCONNECT.jpg)** to see what to enter in ClassiCube when connecting.
