# The Neubit VMS Windows appliance

One installer on a Windows server gives you three things: the VMS running under a
supervised distro, the web console on the LAN, and a desktop app that loads the
same console. This directory is the server half; [`../../desktop/`](../../desktop/)
is the app.

> **This is P2 of [`docs/DESKTOP_APPLIANCE_PLAN.md`](../../docs/DESKTOP_APPLIANCE_PLAN.md).**
> Route B — the stack runs in a private WSL2 distro, so what the appliance executes
> is *the same compose file and the same images* that run in development. Parity is
> not maintained; it is the same artifact.

## The shape

```
Windows host
│
├── Auto-logon of the install account       ── set up by hand, netplwiz
│      └── Scheduled task "Neubit VMS appliance"   ── AT LOGON, that account
│             └── wsl -d neubit-vms -- /opt/neubit/boot.sh boot
│
└── WSL2 distro  neubit-vms                 ── imported into that account's profile
       │  /etc/wsl.conf  →  [boot] command=/opt/neubit/boot.sh
       ├── dockerd                          ── started by boot.sh, ONE launcher
       └── docker compose up -d             ── deploy/docker-compose.yml
                                               + docker-compose.appliance.yml
```

Windows does one thing: start the distro when the account signs in. Everything else
is inside it, because that is where the product already knows how to run.

### Why a logon task and not a boot task

Because there is no boot task that can work. This design was a SYSTEM-owned distro
started at startup, which is the right shape for an appliance and is no longer
available:

```
Running WSL as local system is not supported.
Error code: Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED
```

The obvious fallback dies too, for a second and independent reason: the Store build
of WSL cannot be reached from session 0 at all, so a task under an ordinary account
with *run whether user is logged on or not* fails as surely as one under SYSTEM
([microsoft/WSL#9271](https://github.com/microsoft/WSL/issues/9271),
[#11280](https://github.com/microsoft/WSL/issues/11280)). No scheduled task of any
shape starts a distro with nobody signed in.

Pinning an older WSL is not a third option. The Store updates it in the background,
and there are already reports of exactly that breaking auto-start
([#41394](https://github.com/Microsoft/wsl/issues/41394)) — which would take the
appliance down at some later reboot on a customer site rather than here, in front
of the person installing it.

So unattended restart is bought where it is actually available: **auto-logon**, the
same way Docker Desktop gets a Windows box back after a power cut. That is a
deliberate trade, and it is the one place this design asks something of the
customer's security posture. `probe-system-wsl.ps1` checks whether the box can even
do it — a domain-joined machine may be forbidden by Group Policy, and that is worth
knowing before promising a server that restarts itself.

## Files

| | |
|---|---|
| `build-appliance.ps1` | **Build machine.** Bakes the distro tarball — engine and every release image already inside — into `dist/appliance/`. |
| `install-appliance.ps1` | **Customer machine, elevated.** Imports the distro as the account running it, wires storage, opens the firewall, registers the logon task. |
| `uninstall-appliance.ps1` | Undoes it. Keeps the data unless told otherwise. |
| `probe-system-wsl.ps1` | Verifies a candidate box *before* you install on it. See below. |
| `appliance/wsl.conf` | Goes to `/etc/wsl.conf` in the distro. |
| `appliance/boot.sh` | Goes to `/opt/neubit/`. The distro's init. |
| `appliance/docker-compose.appliance.yml` | Merged over the base compose inside the distro. |

## Build a release

```powershell
cd deploy\windows
.\build-appliance.ps1 -Version 0.1.0

cd ..\..\desktop
npm run package:win
```

The first step produces `dist\appliance\` (2.9 GB); the second produces the
installer (78 MB). **A release is both, shipped together:**

```
Neubit VMS 0.1.0\
  Neubit VMS Setup 0.1.0-x64.exe     78 MB   the shell + the hooks
  appliance\                        2.9 GB   the server
    neubit-vms.tar.gz
    install-appliance.ps1  uninstall-appliance.ps1  probe-system-wsl.ps1
    appliance.json  README.md
```

The installer looks for `appliance\` **next to itself** and installs the server
half when it is there. Run the exe on its own and you get a **client-only**
install — the right thing for an operator workstation that connects to a server
elsewhere, and a supported product rather than a degraded one.

### Why the payload is not inside the exe

It cannot be. `makensis` is a 32-bit program and memory-maps the blob it embeds,
so a 2.9 GB payload fails the build outright, at the last step, after doing all
the work:

```
File: failed creating mmap of "...neubit-vms-desktop-0.1.0-x64.nsis.7z"
APP_64_UNPACKED_SIZE=3275259
```

Getting under the limit is not on the table either — the distro is 5.7 GB raw and
2.9 GB gzipped, and the only way below that is to stop shipping the images, which
is the whole of Route B.

Beside-the-installer is also the better fit for the case this product has to
serve: an **air-gapped site**, where delivery is a folder on a USB stick and a web
installer is not an option.

### Run it from a local disk

Copy the folder to the machine first. `wsl --import` reads 2.9 GB through the
Windows redirector when the payload sits on a share, and a dropped connection
surfaces deep inside the import as an error that says nothing about the network. A
local folder, or a USB stick with a drive letter, is fine.

Unblock the zip **before** extracting it — Properties → Security → *Unblock*, or
`Get-ChildItem <dir> -Recurse | Unblock-File` afterwards. Mark-of-the-Web rides on
every extracted `.ps1` otherwise and PowerShell refuses them as unsigned, which
reads like a corrupt download. On a stock Windows 11 the execution policy also
blocks local scripts outright; set it for the one window rather than the machine:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

## Install

```powershell
# Elevated, AS THE ACCOUNT THE SERVER WILL AUTO-LOGON.
.\install-appliance.ps1 -DistroDir 'C:\Neubit\distro' -BulkDir 'D:\NeubitData'
```

Which account runs it matters now: the distro is registered to it, the logon task
triggers on it, and the uninstaller must be run as it too. Installing as a personal
admin account and then auto-logging-on a different one gives a machine that signs
itself in and starts nothing.

### Two paths, not one

`-DistroDir` holds the **database** and every container layer. `-BulkDir` holds
**recordings** and the offline basemap.

Give them different disks when the machine has them. The P0 spike made the case by
itself on a box with an NVMe C: and a mechanical D: — with the distro on the
spinning disk, `apt-get install` of four small packages sat for minutes in
`jbd2_log_wait_commit`, which is ext4's journal fsync. Postgres does that all day.
The installer detects a mechanical disk under `-DistroDir` and refuses without
`-Force`.

## The build is unsigned — what a customer sees

A deliberate decision (2026-08-27), not an oversight. It costs one dialog, and a
field engineer who has not seen it before will read it as a failed download.

The installer requests elevation, so Windows shows **"Windows protected your PC"**
on a blue SmartScreen panel with only a *Don't run* button in sight:

1. Click **More info** — the small link under the message.
2. The publisher line reads **Unknown publisher**. Expected for this build.
3. Click **Run anyway**.
4. The ordinary UAC prompt follows. That one is expected of any per-machine
   installer and is not related to signing.

Some managed environments remove *Run anyway* by policy — SmartScreen set to *Warn
and prevent bypass*, or WDAC / AppLocker publisher rules. On those machines the
build cannot be installed at all until it is signed. That is the trigger to buy the
certificate, and it is worth asking a customer's IT **before** shipping them an
installer rather than discovering it on site.

`Get-FileHash` on the `.exe` is what to give somebody who wants to check they
received what we sent. It is not a signature and does not stand in for one: it only
shows the file did not change in transit, and only if the hash reached them by a
different route.

## Before you install: probe the box

```powershell
# Elevated.
.\probe-system-wsl.ps1 -Rootfs C:\temp\rootfs.tar
```

It answers the questions that decide whether this design works on that hardware,
and undoes everything it does:

1. Is WSL 2 there and usable?
2. Can **this account** import, start and unregister a distro?
3. What can SYSTEM do here — reported, not graded, because it explains the design.
4. Can this machine be made to sign itself in?
5. Is `networkingMode=mirrored` available (Windows 11 / Server 2022+)?
6. Can the Hyper-V firewall be opened for WSL?
7. Which disks are mechanical?

**Question 2 is the gate.** It runs the exact sequence the installer runs, as the
same account, in the same session. If it fails, nothing else on the list matters.

**Question 4 is the one that reaches the customer.** A logon task only survives a
power cut if the machine logs itself in, and on a domain-joined box that is Group
Policy's decision rather than yours. Discovering it afterwards means telling a
customer their server does not restart.

The probe cannot prove the last mile. **Only a reboot proves it.** Install,
configure auto-logon, reboot, touch nothing, and browse to the box from another
machine.

## Networking: two gates, and both are shut by default

WSL2's default NAT publishes a distro's ports to the host's **loopback only**. So
out of the box a LAN browser is refused, which is half the product missing.

The installer opens both gates:

1. **`networkingMode=mirrored`** in the *install account's* `.wslconfig`, so the
   distro shares the host's interfaces and a socket bound `0.0.0.0` answers on the
   LAN address.
2. **A Hyper-V firewall rule.** Mirrored mode alone is not enough:
   `Get-NetFirewallHyperVVMSetting` reports `DefaultInboundAction: Block`. In the
   P0 spike the socket was bound and answering *from inside the distro* while
   Windows refused the identical URL, with nothing in any log mentioning a
   firewall. It presents as a server that is up and unreachable — the single most
   likely support ticket for this product.

### `http://localhost` does not work on the appliance itself

Turning mirroring on takes loopback away, and this surprises everyone who meets it.
Mirrored mode makes the distro share the **host's** loopback, and Docker's published
port is not on it: the DNAT rule Docker installs sits in `PREROUTING` and covers
traffic arriving on an interface, while loopback would need `docker-proxy`, which is
not listening. Measured on the first customer machine:

```
direct to the container (172.18.0.4)  : 200
the distro's eth0       (10.24.103.39): 200
loopback                (127.0.0.1)   : 000
```

So **use the machine's LAN address, on the appliance as well as from the network.**
`install-appliance.ps1` probes every local IPv4 and prints the one that answered;
that is the address to give the customer. An operator who tries `localhost` on the
box, finds it refused and concludes the appliance is down will be wrong, and the
installer says so out loud for exactly that reason.

`.wslconfig` is machine-wide. The uninstaller deliberately leaves it, and says so,
rather than silently reverting a global network setting another distro may depend on.

## What is deliberately not here

**The offline basemap.** `deploy/tiles/planet.pmtiles` is 3.7 GB — larger than
every container image combined, and the reason a full installer is ~5.3 GB instead
of ~1.6 GB. It ships as a separate optional download, copied into
`<BulkDir>\tiles\`. `TILES_MAXZOOM` (default 10) already supports a reduced-zoom
file, so a smaller basemap is a supported configuration rather than new work.

**In-place upgrade.** The first release is install-only, and this is stated in the
installer rather than papered over: the database lives in named volumes *inside* the
distro's virtual disk, so replacing the distro discards it. The export/import dance
that would preserve it has not been written or tested, and the NVR's two upgrade
post-mortems are the argument for not guessing. For now: `uninstall-appliance.ps1
-KeepData`, then install.

A distro left behind by an install that *crashed* is not an upgrade, and is no
longer treated as one. The installer records a real install in
`%ProgramData%\Neubit\VMS\install-state.json` at the moment `/opt/neubit/.env` is
written — the point past which a database can exist — so a registered distro with
no such record is replaced without asking, because there is nothing inside it to
lose. Deleting that file by hand tells the next install it may destroy the
database.

## If something goes wrong

```powershell
wsl -d neubit-vms -u root -- tail -50 /var/log/neubit-boot.log
wsl -d neubit-vms -u root -- /opt/neubit/boot.sh status
wsl -d neubit-vms -u root -- tail -50 /var/log/dockerd.log
```

Run those **as the account that installed it**. WSL registers distros per user, so
any other account — including an administrator — is told the distro does not exist.

### The console does not come back after a reboot

Sign in and check whether it starts then. If it does, the appliance is fine and
auto-logon is what is missing:

```powershell
netplwiz     # clear "Users must enter a user name and password"
Get-ScheduledTask -TaskName 'Neubit VMS appliance' | Select-Object State, @{n='LastResult';e={($_ | Get-ScheduledTaskInfo).LastTaskResult}}
```

### The failure that looks like corruption

If the engine reports `images=0` while `/var/lib/docker` is several GB, two
different launchers have been used. A bare `dockerd` and systemd's `docker.service`
bring up different containerd instances, and therefore different image stores; the
images are all still on disk, just not in the store being asked. This is why
`wsl.conf` sets `systemd=false` and why `boot.sh` is the only place `dockerd` is
started — including at bake time, so the store the release pipeline writes to is by
construction the store the appliance reads from.

### A note for anyone validating from Git Bash

`docker compose config` run from Git Bash rewrites `/mnt/d/...` to
`C:/Program Files/Git/mnt/d/...` in the output. That is Git Bash's POSIX-path
translation, not a fault in the compose file — inside the distro the path is used
verbatim. Validate from PowerShell, or ignore that one line.
