# Chrome Web Store listing

Texts to paste into the Chrome Web Store developer dashboard. Images: `store-screenshot.png` (1280 × 800), `store-tile.png` (440 × 280, small promo tile), `../extension/icons/icon128.png` (store icon). Make them with `node promo/render-store.js`.

Upload: a zip of the files inside `extension/` (the manifest at the top of the zip).

## Store listing tab

**Name** (from the manifest): Meet Mixer

**Summary** (from the manifest's description): A volume slider for every person in a Google Meet call.

**Category**: Communication

**Language**: English

**Description**:

```
Too loud? Too quiet? Meet Mixer gives every person in your Google Meet call their own volume slider.

• Turn each person down, or up to 300 %
• Mute someone just for you (the others still hear them)
• Names fill in by themselves as people talk
• Pin people to the top and search the list, handy in big calls
• Volumes are remembered by name for your next meeting
• A small round button on the Meet page opens the panel; drag it anywhere. The toolbar icon opens it too.

Privacy: Meet Mixer works only inside your browser. It sends nothing anywhere, has no account, no tracking and no ads. Your volumes are saved only on your computer.

Meet Mixer only changes what you hear. Nobody else in the call is affected, and nobody can see that you use it.

Open source (MIT): https://github.com/get-wrecked/Meet-Mixer

Meet Mixer is not made by or affiliated with Google. Google Meet is a trademark of Google LLC.
```

## Privacy practices tab

**Single purpose**:

```
Lets the user set a separate volume (and mute) for each person in a Google Meet call, for their own speakers only.
```

**Permission justifications**:

- activeTab: `When the user clicks the toolbar icon on a Google Meet tab, the extension opens or closes its volume panel in that tab.`
- scripting: `Used only on the toolbar click, to tell the extension's code already running in the Google Meet tab to open or close its panel.`
- Host permission (content script on meet.google.com): `The extension runs only on meet.google.com. It needs to run there to route each person's call audio through its own volume control before it reaches the speakers.`

**Remote code**: No, I am not using remote code. (All code is in the package.)

**Data usage**: tick nothing (no user data is collected). Tick the three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL** (optional when nothing is collected): `https://github.com/get-wrecked/Meet-Mixer#privacy`

## Test instructions (for the reviewer, optional)

```
Join any Google Meet call with at least one other person. A round blue button appears on the page; click it (or the toolbar icon) to open the panel. Each person who talks gets a row with a volume slider and a mute button. The content script runs in the page's main world because it has to wrap the page's WebRTC and Web Audio objects to put a volume control on each incoming audio stream; it makes no network requests.
```
