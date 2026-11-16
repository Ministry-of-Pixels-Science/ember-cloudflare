# A huddle's sounds

What a huddle plays besides the voices in it (`../huddle-sounds.ts`), where Slack's huddles have
sounds of their own.

| File | Plays | What it is |
|---|---|---|
| `joined.mp3` | As someone joins the huddle, the tab's own person included | Two marimba notes a fourth apart, rising (E5, A5): 0.7 s, mono |
| `left.mp3` | As someone leaves it, the tab's own person included | The same two notes, falling |
| `music.mp3` | To whoever is the only one in the huddle, from five seconds after they find themselves alone until someone joins them | "The Rotary Dial Shuffle", music to wait to: 2 min 50 s, stereo, 1.9 MB, played on a loop. It starts from silence and ends on a fade into two seconds of it, so the loop turns over on a rest |

The two short sounds were written for Ember and are under its license (`LICENSE`): nobody is owed a
royalty or a credit for them, and nothing in them is sampled from anyone's recording. FluidSynth
played them through the Fluid R3 General MIDI SoundFont, which Frank Wen released under the MIT
license (`FluidR3-GM-LICENSE.txt`).

The music was generated for Ember by Google's generative AI on 13 November 2026: no person wrote or
played it. The file it came as said so in content credentials (C2PA) that Google had signed, and
Google put its inaudible SynthID watermark in the sound. Google's
[Terms of Service](https://policies.google.com/terms) claim no ownership of what its services
generate and forbid passing it off as a person's work, so nobody is owed a royalty or a credit for
it either. Here it's the piece as it was generated, only turned down to the level below and encoded
again, which leaves the watermark alone and the credentials behind, since they vouch for the file
they came in. It's under Ember's license with the rest, as far as a piece no person wrote is
anyone's to license.

A file plays as loud as it is, since a phone's browser plays an `<audio>` at no volume but the
phone's own. So each is levelled as it should sound: the two sounds peak at -13 dBFS, and the music
measures -30 LUFS, well under a voice. To change one, put another MP3 in its place under the same
name, levelled the same way. The music starts over from wherever its file ends, so a piece that ends
on a rest turns over cleanly, and the page fetches the whole file before playing it, so a small one
starts sooner. For a piece of music, ffmpeg does both:

```sh
ffmpeg -i piece.mp3 -af ebur128 -f null -   # prints its loudness: "I: -12.7 LUFS"
ffmpeg -i piece.mp3 -af volume=-17.3dB -codec:a libmp3lame -q:a 6 -map_metadata -1 music.mp3   # -30 less that
```
