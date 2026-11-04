# Producer 0.4.82

Fixes a startup crash on macOS 27 when OBS reads the active keyboard input source. OBS startup now runs on the macOS main queue, with subsequent graphics and module initialization on the engine thread.

Local macOS 27 verification confirmed successful OBS startup, Metal initialization and browser initialization with the production native guest runtime compiled in.

Includes the room, Sets, Sounds and Activity improvements from 0.4.81.
