-- Post to LinkedIn
-- Uses: Safari do JavaScript to interact with LinkedIn's UI
-- Requires: Safari > Develop > Allow JavaScript from Apple Events
-- LinkedIn-specific because it has no direct compose URL

on run argv
	set postText to item 1 of argv

	tell application "Safari"
		activate

		-- Open LinkedIn feed
		if (count of windows) is 0 then
			make new document
		end if
		set URL of current tab of front window to "https://www.linkedin.com/feed/"

		-- Wait for feed to load
		delay 5

		-- Click the "Start a post" button
		set clickResult to do JavaScript "
			(function() {
				var btn = document.querySelector('button.share-box-feed-entry__trigger');
				if (!btn) {
					var allBtns = document.querySelectorAll('button');
					for (var i = 0; i < allBtns.length; i++) {
						if (allBtns[i].textContent.trim().indexOf('Start a post') !== -1) {
							btn = allBtns[i];
							break;
						}
					}
				}
				if (!btn) return 'NOT_LOGGED_IN';
				btn.click();
				return 'COMPOSE_OPENED';
			})()
		" in current tab of front window

		if clickResult is "NOT_LOGGED_IN" then
			return "ERROR: Not logged in to LinkedIn. Please log in via Safari."
		end if

		-- Wait for compose modal to open
		delay 3

		-- Set clipboard and paste (most reliable for contenteditable)
		set the clipboard to postText

		tell application "System Events"
			keystroke "v" using command down
		end tell

		delay 2

		-- Click the Post button
		set postResult to do JavaScript "
			(function() {
				var btn = document.querySelector('button.share-actions__primary-action');
				if (!btn) {
					var allBtns = document.querySelectorAll('button');
					for (var i = 0; i < allBtns.length; i++) {
						var txt = allBtns[i].textContent.trim();
						if (txt === 'Post' && allBtns[i].offsetParent !== null) {
							btn = allBtns[i];
							break;
						}
					}
				}
				if (!btn) return 'POST_BUTTON_NOT_FOUND';
				btn.click();
				return 'POSTED';
			})()
		" in current tab of front window

		return postResult
	end tell
end run
