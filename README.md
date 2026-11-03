# Meet Mixer

A Chrome extension that gives every person in a Google Meet call their own volume slider.

![Meet Mixer feature tour](promo/meet-mixer-tour.gif)

## Features

- Turn each person down, or up to 300 %
- Mute someone just for you (they don't notice)
- Names fill in by themselves once someone talks
- Pin people to the top and search the list
- Volumes and pins are remembered for your next meeting
- Drag the button anywhere; the panel opens toward the free side

## Install

Meet Mixer isn't in the Chrome Web Store, so it's loaded by hand:

1. Download this repository (Code → Download ZIP) and unzip it somewhere it can stay.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. Open or reload a Google Meet tab.

A blue round button appears at the bottom left of the Meet page; click it (or the toolbar icon) to open the panel. To update, replace the folder with the new version and click the reload arrow on the extension's card.

## How it works

Google Meet doesn't send one audio stream per person. It sends about three streams for whoever is talking loudest, and they switch between people. Meet Mixer runs inside the Meet page and:

- reads who is talking on each stream from the audio packets (each one carries its speaker's ID),
- puts its own volume control on each stream, between Meet and your speakers,
- sets each stream to the volume of whoever is on it right now, about 50 times a second, timed to when Meet actually plays the sound,
- takes names from Meet's tiles while exactly one person is talking.

Meet plays audio in one of two ways (decoding it itself, or letting Chrome do it); both are handled. It all depends on how Meet works today, so a Meet update can break it. Double-click the panel title to show technical details and **Copy details** for a bug report.

## Privacy

Meet Mixer only runs on `meet.google.com`. It sends nothing anywhere: no servers, no tracking. Names, volumes and pins stay in your browser (local storage of the Meet site).

## Development

- `extension/`: everything Chrome loads (`manifest.json`, `inject.js`, `background.js`, `icons/`).
- `test/`: test pages that work without Meet. Run `node test/serve.js` and open `http://localhost:8790/test/loopback.html` (audio elements) or `/test/meet-like.html` (Meet's own decoding, with fake tiles).
- `tools/make-icons.js`: draws the icons (Node, no packages).
- `promo/`: the ad image and the feature tour; `node promo/render.js` and `node promo/render-tour.js` render them with Chrome (the tour also needs ffmpeg).

Meet Mixer is not made by or affiliated with Google.

## License

[MIT](LICENSE) © Medal
