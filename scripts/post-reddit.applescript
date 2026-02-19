-- Post a comment on a Reddit post
-- Uses: clipboard + browser-specific JavaScript execution
-- Arguments: commentText (the comment body), postURL (full Reddit post URL)
-- Supports: Safari, Google Chrome, Arc, Brave, Edge (Chromium browsers)
-- Requires: macOS Accessibility permission; Safari needs Develop > Allow JavaScript from Apple Events

on run argv
	set commentText to item 1 of argv
	set postURL to item 2 of argv

	-- Set clipboard to comment text
	set the clipboard to commentText

	-- Open the specific Reddit post in default browser
	do shell script "open '" & postURL & "'"

	-- Wait for page to load
	delay 6

	-- Detect which browser is frontmost
	tell application "System Events"
		set frontApp to name of first application process whose frontmost is true
	end tell

	-- JavaScript to focus the comment box and scroll to it
	set focusJS to "
(function() {
  // New Reddit (shreddit) — look for the main comment composer
  var composer = document.querySelector('shreddit-composer');
  if (composer) {
    var shadow = composer.shadowRoot;
    if (shadow) {
      var editor = shadow.querySelector('[contenteditable=\"true\"]');
      if (editor) {
        editor.scrollIntoView({behavior: 'smooth', block: 'center'});
        editor.focus();
        editor.click();
        return 'FOCUSED_SHREDDIT';
      }
    }
  }

  // Try contenteditable div inside comment area
  var editables = document.querySelectorAll('div[contenteditable=\"true\"]');
  for (var i = 0; i < editables.length; i++) {
    var el = editables[i];
    // Skip tiny or hidden editors
    if (el.offsetHeight > 20 && el.offsetWidth > 100) {
      el.scrollIntoView({behavior: 'smooth', block: 'center'});
      el.focus();
      el.click();
      return 'FOCUSED_CONTENTEDITABLE';
    }
  }

  // Try textarea fallback (old Reddit or markdown mode)
  var textareas = document.querySelectorAll('textarea');
  for (var i = 0; i < textareas.length; i++) {
    var ta = textareas[i];
    var placeholder = (ta.placeholder || '').toLowerCase();
    if (placeholder.indexOf('comment') !== -1 || placeholder.indexOf('thought') !== -1 || ta.name === 'text') {
      ta.scrollIntoView({behavior: 'smooth', block: 'center'});
      ta.focus();
      ta.click();
      return 'FOCUSED_TEXTAREA';
    }
  }

  return 'NOT_FOUND';
})()
"

	-- JavaScript to click the Comment/Submit button
	set submitJS to "
(function() {
  // New Reddit — button with slot='submit-button' or type='submit'
  var submitBtn = document.querySelector('button[slot=\"submit-button\"]');
  if (submitBtn && submitBtn.offsetParent !== null) {
    submitBtn.click();
    return 'SUBMITTED';
  }

  // Look for button containing 'Comment' text
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var txt = buttons[i].textContent.trim();
    if (txt === 'Comment' && buttons[i].offsetParent !== null) {
      buttons[i].click();
      return 'SUBMITTED';
    }
  }

  // Old Reddit submit button
  var oldSubmit = document.querySelector('button[type=\"submit\"].save');
  if (oldSubmit) {
    oldSubmit.click();
    return 'SUBMITTED';
  }

  return 'SUBMIT_NOT_FOUND';
})()
"

	-- Execute focus JS based on detected browser
	set focusResult to ""

	if frontApp contains "Safari" then
		tell application "Safari"
			set focusResult to do JavaScript focusJS in current tab of front window
		end tell
	else
		-- Chrome, Arc, Brave, Edge all support this syntax
		try
			if frontApp contains "Chrome" then
				tell application "Google Chrome"
					set focusResult to execute front window's active tab javascript focusJS
				end tell
			else if frontApp contains "Arc" then
				tell application "Arc"
					set focusResult to execute front window's active tab javascript focusJS
				end tell
			else
				-- Generic fallback: try System Events to tab to comment box
				tell application "System Events"
					-- Tab several times to hopefully reach comment area
					repeat 5 times
						keystroke tab
						delay 0.3
					end repeat
				end tell
				set focusResult to "FALLBACK_TAB"
			end if
		on error errMsg
			-- If browser JS fails, try System Events
			tell application "System Events"
				repeat 5 times
					keystroke tab
					delay 0.3
				end repeat
			end tell
			set focusResult to "FALLBACK_TAB"
		end try
	end if

	if focusResult is "NOT_FOUND" then
		return "ERROR: Could not find comment box. Make sure you are logged in to Reddit."
	end if

	-- Small delay for focus to settle
	delay 1

	-- Paste comment text from clipboard
	tell application "System Events"
		keystroke "v" using command down
	end tell

	-- Wait for text to be pasted
	delay 2

	-- Click the Comment button
	set submitResult to ""

	if frontApp contains "Safari" then
		tell application "Safari"
			set submitResult to do JavaScript submitJS in current tab of front window
		end tell
	else
		try
			if frontApp contains "Chrome" then
				tell application "Google Chrome"
					set submitResult to execute front window's active tab javascript submitJS
				end tell
			else if frontApp contains "Arc" then
				tell application "Arc"
					set submitResult to execute front window's active tab javascript submitJS
				end tell
			else
				-- Fallback: try Cmd+Enter or Tab+Enter
				tell application "System Events"
					keystroke return using command down
				end tell
				set submitResult to "FALLBACK_SUBMIT"
			end if
		on error errMsg
			tell application "System Events"
				keystroke return using command down
			end tell
			set submitResult to "FALLBACK_SUBMIT"
		end try
	end if

	if submitResult is "SUBMIT_NOT_FOUND" then
		return "ERROR: Comment pasted but could not find Submit button. Please submit manually."
	end if

	delay 2
	return "POSTED"
end run
