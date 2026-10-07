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

<img width="333" height="235" alt="image" src="https://github.com/user-attachments/assets/ff8417f7-8ccb-42d0-b793-d73460f502f4" />


## Screenshot
<img width="1280" height="674" alt="image" src="https://github.com/user-attachments/assets/69ee627b-9a18-460a-a8a0-a753919bfcf4" />

