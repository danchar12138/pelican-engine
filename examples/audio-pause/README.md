# Audio pause game probe

This MIT example uses the public `pelican-engine` SDK and the original procedural
WAV from the M2 example. In the running game, `p` starts two looping voices,
`a` pauses the target voice, `r` resumes it and `s` stops both. `m` reduces
the music bus and `u` restores it; the other voice uses a separate effects bus.

From the repository root, run the automated browser/game probe:

```powershell
node --import tsx tools/audio-pause-game-probe.ts --exclusive-gpu --output .pelican/audio-pause-probe
```

The probe automates the browser user gesture required for audio, and records
native node calls and logical state. It does not claim speaker output or full M6
acceptance.

For an independently installed npm project containing the same game source,
manifest and asset, pass `--installed-root <project-directory>` to the probe.
The installed SDK and CLI are used without importing engine source into the game.
