XPI = hatschi.xpi
BUILD = build

.PHONY: firefox chromium clean

firefox:
	rm -rf $(BUILD)
	mkdir $(BUILD)
	cp -r _locales css images js content planner vendor background.js LICENSE.md $(BUILD)/
	cp manifests/firefox/manifest_.json $(BUILD)/manifest.json
	cd $(BUILD) && zip -r ../$(XPI) .

chromium:
	rm -rf $(BUILD)
	mkdir $(BUILD)
	cp -r _locales css images js content planner vendor background.js LICENSE.md $(BUILD)/
	cp manifests/chromium/manifest_.json $(BUILD)/manifest.json
	cd $(BUILD) && zip -r ../hatschi-chromium.zip .

clean:
	rm -rf $(BUILD) $(XPI) hatschi-chromium.zip