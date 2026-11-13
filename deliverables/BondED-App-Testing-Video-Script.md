# BondED: Complete App Testing Video Script

Prepared: September 25, 2026

Purpose: Record how the app behaves, including successful actions, errors, and different user permissions. This is a testing script based on the current project source. It is not a report that the tests have already passed.

## How to use this script

Read the **Say** paragraph aloud, then perform the numbered **Show and check** steps. Each step includes the result to check. Use the scene and step as the test ID: scene 03, step 2 becomes **03.2**. Mark each result **PASS**, **FAIL**, or **BLOCKED** in the recording log. Mark **N/A** only when a feature does not apply to the tested platform or account, and give the reason.

Record in chapters. A full test run will take longer than a short presentation, especially with uploads, email codes, multiple accounts, and background jobs. You can edit waiting time out of the presentation, but keep the original clips as evidence. Do not say that everything works unless your actual results support that statement.

### Prepare before recording

| Item | Preparation |
| --- | --- |
| Build | Install the exact APK being tested. Record app version/build, phone model, Android version, date, and connection type. Include an older/slower phone if available. |
| Devices | Use two phones for sender/receiver, viewer/host, typing, read status, and notification tests. Label recordings Phone A and Phone B. |
| Accounts | Student A and Student B with complete profiles; a new student with incomplete setup; a teacher; a moderator; an administrator. Have another test student available for first-ever conversation and join-request tests. |
| Email | Use test inboxes you can access for verification and password recovery. Hide passwords and email codes in the final public video. |
| Test area | Use a test community and clearly named content such as VIDEO TEST. Run account recovery, mass year promotion, data migration, and bulk deletion only against isolated test accounts/data. |
| Files | Prepare a portrait photo, a landscape photo, a short video with sound, PDF, DOC, DOCX, XLS, XLSX, PPT, and PPTX files. Include a long filename with spaces. Record each file's actual size. |
| Other fixtures | A long conversation with an old searchable message; at least four join requests; an expired poll; past/upcoming/cancelled events; test reports; and a harmless moderation-review fixture. |
| Permissions | Know each account's configured permissions. A hidden admin button alone does not prove that a protected action is secure. |
| Services | Confirm which backend, rules, upload, email, push, AI, and live services this APK uses. If a dependency is unavailable, record BLOCKED and its reason. |

For live broadcasting and push notifications, use the installed build being evaluated. A result from Expo Go alone is not evidence that the APK passes those tests.

### Recording chapters

| Chapter | Scenes | Focus |
| --- | --- | --- |
| A | 01–05 | Introduction, login, setup, recovery, Home |
| B | 06–14 | Posts, media, mentions, anonymous content, comments, replies, polls |
| C | 15–21 | Communities, server channels, direct messages, notifications |
| D | 22–27 | Events, B.E.A., live video, settings, support |
| E | 28–34 | Account administration, analytics, moderation, knowledge, support management |
| F | 35–36 | Shared regression tests, results, closing |

## Chapter A — Access and navigation

### 01 — Opening and app launch

**Account:** Signed out, then Student A.

**Say:** “Good day. We are testing BondED, our school community app. We will show what students and staff can do, check the results on another account, and test how the app handles mistakes and connection problems.”

**Show and check:**

1. Show the app icon and the build/device details on a title card. Open the installed app. **Expected:** The app starts without crashing or staying on a blank screen.
2. Start signed out. **Expected:** Login appears; protected school content is not accessible.
3. Close and reopen after signing in later. **Expected:** A valid session resumes correctly; incomplete setup still opens Setup.
4. Show the top and bottom of the phone. **Expected:** Important controls avoid the battery, Wi-Fi, status bar, and navigation buttons.

### 02 — Login and session access

**Account:** Existing Student A, then a locked test account.

**Say:** “First, we test signing in. The app should accept the correct school account and explain why a wrong or incomplete login cannot continue.”

**Show and check:**

1. Submit empty fields, then an incorrect password and an unknown school ID. **Expected:** Clear feedback; no access to Home.
2. Use the password eye icon. Type with the keyboard open. **Expected:** Visibility toggles correctly and the active field remains reachable.
3. Sign in with the correct details for an already completed account. **Expected:** Home opens without repeating completed profile setup.
4. Sign out and press Android Back. **Expected:** Back does not reopen a protected signed-in screen.
5. Attempt login with the account locked by the admin in scene 29. **Expected:** The app refuses access and offers a useful explanation/help path.
6. Disconnect before login, submit once, reconnect, and retry. **Expected:** No false success or permanent loading state; a valid retry works.

### 03 — Required profile setup

**Account:** New student with a temporary password and incomplete profile.

**Say:** “A new account must finish its profile before using the app. We will add a photo, verify an email address, accept the community rules, and replace the temporary password.”

**Show and check:**

1. Sign in. Check the welcome heading and setup instructions. Try Continue with missing fields. **Expected:** Required information is clearly identified and Home remains blocked.
2. Choose a photo, cancel once, then select and replace it. Test a denied photo permission. **Expected:** The avatar previews the selected photo; cancellation preserves previous data; permission errors are understandable.
3. Enter an invalid email, then a valid test email. Request a code. **Expected:** Invalid format is rejected; the code goes to the chosen inbox.
4. Enter an incorrect code; test an expired code using the normal expiry period. Use resend and its cooldown. **Expected:** Bad/expired codes do not verify; resend behaves as indicated.
5. Change the email while verification is pending. **Expected:** A code for the previous email cannot verify the new address. Verify the final address with its current code.
6. Enter a weak password and mismatched confirmation, then a valid personal password. Test each eye icon. **Expected:** The stated password requirements and confirmation are enforced; existing self-chosen passwords do not require an unnecessary change.
7. Open the rules, scroll to the bottom, and use the unchecked agreement control. **Expected:** Rules are readable; buttons are above the phone navigation bar; continuing requires agreement.
8. Leave setup incomplete and sign in again. Try Back or reopening the app. **Expected:** Setup cannot be bypassed.
9. Complete every requirement and tap Continue once. **Expected:** A saving state appears; one successful save opens Home. After relaunch, photo and verified email persist and setup is skipped.

### 04 — Forgot password and sign-in help

**Account:** Test account with a verified recovery email; another account needing help.

**Say:** “Next, we test account recovery. A user should be able to reset a forgotten password or ask for help if the normal reset process is unavailable.”

**Show and check:**

1. Open Forgot Password and enter the required account information. Request a reset code. **Expected:** The flow explains what to do next without exposing another person's full private details.
2. Try a wrong code, expired code, and resend. Then use the correct code. **Expected:** Only a valid current code advances.
3. Try weak/mismatched new passwords; then save a valid one. **Expected:** Validation works. The new password signs in and the old password fails.
4. Type in every code/password field with the keyboard visible. **Expected:** The active field and action buttons remain reachable.
5. Open Sign-in Help. Try an empty request, then submit a clear test issue. **Expected:** Required fields are validated and a successful submission has a reference or clear acknowledgement.
6. Confirm the test help request reaches the authorized support queue in scene 34. **Expected:** It is not lost or duplicated after one submission.

### 05 — Home, search, and navigation

**Account:** Student A.

**Say:** “Home shows community content. We will check the main tabs, search, filters, and links to people and posts.”

**Show and check:**

1. Open Home, Notifications, B.E.A., Profile, and any Dashboard access allowed for this account. **Expected:** Each opens correctly and only permitted tools appear.
2. Refresh the feed and scroll through more content. **Expected:** Items load without duplicates, missing controls, or a stuck spinner.
3. Search a known VIDEO TEST phrase, poll question, and person's name. Use Everything, Posts, Polls, and People. **Expected:** Appropriate results open their correct targets.
4. Use date and sorting filters, clear the search, and search nonsense text. **Expected:** Filters update results; empty results have a clear message.
5. Open the online-user display and a profile from it. **Expected:** The selected person's profile opens; presence changes are checked across both phones rather than assumed to update instantly.
6. Open the community drawer and return Home using the offered gestures/buttons. **Expected:** Horizontal media swipes and drawer gestures do not fight each other.

## Chapter B — Posts and shared content

### 06 — Create, edit, and delete posts

**Account:** Student A, Student B, and authorized staff.

**Say:** “We will create a post, view it from another account, and test editing and deletion. A user should control their own post, while staff actions must follow their permissions.”

**Show and check:**

1. Open Create Post and submit a completely empty post. **Expected:** Nothing empty is published.
2. Create “VIDEO TEST: Our project demonstration” with a permitted flair. Check Discussion, Question, Help / Advice, Achievement, and Lost & Found. **Expected:** The selected flair and audience are saved correctly.
3. Check the Announcement option as a student and authorized staff member. **Expected:** Staff-only publishing is restricted appropriately.
4. Publish a text post and view it from Student B after any required processing/review. **Expected:** Text, author, time, and final publication state are correct; pending content is not shown as already approved.
5. Like/unlike from both phones, comment, and bookmark. **Expected:** Counts reflect the actual actions without duplicate increments after refresh.
6. Edit your own post, cancel once, then save. **Expected:** Cancel preserves the original; save persists the edit. Another ordinary student cannot edit it.
7. Delete a disposable post: cancel the confirmation first, then confirm. **Expected:** Cancel retains it; confirmed deletion removes it and later links handle the missing post gracefully.
8. For Lost & Found, exercise the available claim/return status actions using the authorized account. **Expected:** Lost/Found, Claim Pending, and Returned states follow the intended sequence. Check automatic returned-item archiving with prepared aged test data, not by changing the phone clock.

### 07 — Photo and video carousel

**Account:** Student A and Student B.

**Say:** “This post contains different photos and a video. We will check the swipe layout, full-screen viewing, and whether videos stop when they are no longer being watched.”

**Show and check:**

1. Publish a mixed set: portrait photo, landscape photo, short video, and another photo. **Expected:** The saved order matches the chosen order.
2. Swipe slowly, quickly, and to both ends. **Expected:** Cards have usable spacing; the final item does not scroll into a large blank trailing area.
3. Check single-photo and single-video posts too. **Expected:** They do not inherit unnecessary carousel spacing or distort the media.
4. Open the second photo, zoom it, swipe between photos, and close. **Expected:** The viewer starts on the selected media and returns to the same post.
5. Play the video; test sound/mute, seeking, full screen, and available quality controls. Check captions when captions exist. **Expected:** Each control does what its label says; absent captions are not presented as available.
6. Scroll the video offscreen, open another screen, and background the app. **Expected:** Playback/audio does not continue unexpectedly or overlap another playing video.
7. Repeat the carousel check on Home, Profile, Bookmarks, and a post opened from a notification. **Expected:** The same content remains usable in every entry point.

### 08 — Mentions and manual people tags

**Account:** Student A, Student B, and an eligible audience for @everyone.

**Say:** “Mentioning a person in the text and tagging people are different actions. We will check that each behaves correctly and that names open the right profile.”

**Show and check:**

1. In a post, type @ and select Student B. Publish it. **Expected:** The name is highlighted blue and opens Student B's profile; the mention alone does not create an extra Tagged or with row.
2. Repeat named mentions in a comment, reply, and server message. **Expected:** The same separation and profile navigation work.
3. Mention @everyone in each supported surface. **Expected:** It stays blue without opening a profile; an eligible second account receives the appropriate notification according to its settings and audience.
4. Mention @bea where supported. **Expected:** It does not create an unwanted “with B.E.A.” tag row; any assistant response follows that surface's supported behavior.
5. Use the separate tag-people picker. Select several people, cancel, then reopen, select, and Confirm. **Expected:** Cancel does not commit the draft selection; Confirm saves the chosen people.
6. Tag first and then type text. Reverse the order too. **Expected:** The confirmed tags survive typing in either order.
7. Publish several tags. Expand See more, collapse, and tap individual names. **Expected:** Names use a compact comma-separated layout and navigate correctly in posts, comments, replies, and server messages.
8. Choose an @ suggestion while the keyboard is open. **Expected:** The chosen name is inserted once, focus/cursor behavior is usable, and neither suggestions nor the composer get covered.

### 09 — Anonymous content and staff identity access

**Account:** Student A, Student B, teacher, moderator, administrator.

**Say:** “We will test anonymous display from a student's view and a staff view. Students should see the anonymous label and avatar, while authorized staff have the separate identity control.”

**Show and check:**

1. Create anonymous test content in each supported area: post, comment, reply, and server channel. **Expected:** The display uses a neutral anonymous avatar and a label such as Anonymous1234 with no space before the ID.
2. View from Student B, including avatar/name taps. **Expected:** The real author's name or profile is not accidentally exposed through those controls.
3. View from authorized staff and use the identity/eye control. **Expected:** Staff can inspect the actual author only through the permitted identity action.
4. Open anonymous content from Notifications. **Expected:** The anonymous ID is present and staff-only identity controls work there too.
5. Open a named mention inside that anonymous content. **Expected:** It opens the mentioned person's profile, not the anonymous author's profile.
6. Turn anonymity off for a new item. **Expected:** The normal profile display returns for that item without changing previous anonymous content unexpectedly.

### 10 — Comments

**Account:** Student A and Student B.

**Say:** “Now we test comments. We will check text, attachments, sorting, tags, editing, and how errors are shown.”

**Show and check:**

1. Open a post's comments and submit a text comment. Try empty submission too. **Expected:** A valid comment appears once and the post count updates; empty submission is rejected.
2. Use the available sorting/filter controls and load older comments. **Expected:** The list changes as indicated and comments do not disappear incorrectly.
3. Attach a photo, file, link, and GIF using the shared matrix after scene 12. **Expected:** Each supported attachment displays and opens correctly on Student B's phone.
4. Repeat mention, tag-before-text, compact See more, anonymous, and profile-navigation checks. **Expected:** Comment behavior matches scenes 08–09.
5. Edit your comment; cancel, then save. Delete another disposable comment with confirmation. **Expected:** Changes persist correctly and other users' edit controls are not exposed.
6. Force a failed upload using an interrupted connection. **Expected:** The error refers to the comment, keeps a recoverable draft, and does not claim success. Reconnect and ensure retry does not duplicate it.

### 11 — Replies and reply threads

**Account:** Student A and Student B.

**Say:** “Replies should stay connected to the correct comment. We will test opening the thread, sending a reply, editing it, and opening it from a notification.”

**Show and check:**

1. Reply to a specific comment from Student B. Expand and reopen its thread. **Expected:** The reply is under the intended parent and the reply count is consistent.
2. Send text, then use the attachment matrix for replies. **Expected:** Supported files and media work in replies, not only in comments.
3. Test @ mentions, tags with Confirm, tag-before-text, compact See more, and anonymous display. **Expected:** The behaviors in scenes 08–09 work inside the reply thread.
4. Edit your reply and save. **Expected:** The text updates without an unnecessary success modal interrupting the conversation.
5. Delete a disposable reply; cancel before confirming. **Expected:** Cancel makes no change; confirmed deletion updates the thread and count.
6. Open the reply from a notification and tap its named author/mention/tag. **Expected:** The correct thread and profile load; no incorrect “user not found.”
7. Test a reply whose parent was removed and an upload failure. **Expected:** The app handles the missing parent safely and uses reply-specific error wording.

### 12 — Documents, links, GIFs, and emoji

**Account:** Student A and Student B.

**Say:** “We will send the same test files in different parts of BondED. The receiver should see a clear file card and be able to open the correct file. Links should show the actual destination.”

**Show and check:**

1. Complete every cell of the attachment matrix below. Send with text and without text where supported. **Expected:** Valid supported files upload, persist after reopening, and reach the second account.
2. Inspect each received document. **Expected:** The file card shows a document icon, readable filename, and correct size when available. Tapping opens/downloads the intended file; unsupported viewers produce a useful outcome rather than crashing BondED.
3. Add facebook.com with no title, then add it with a title. **Expected:** Title is optional; the displayed destination includes https://facebook.com and remains visible even when a title is supplied. Test an actual URL with a path as well.
4. Try a malformed URL, an empty URL, and an unsafe non-web scheme. **Expected:** Invalid links are rejected. Type in both URL and title fields with the keyboard open; both remain reachable.
5. Search for a GIF, select it, send it, then try a no-result search and a failed network request. **Expected:** Preview/send work; clear empty/error states appear; the GIF picker stays below system icons, shows attribution, and closes with its close button or downward gesture.
6. Insert emoji into existing text, change the insertion position, and send. **Expected:** Text and emoji are preserved and the keyboard/emoji picker can be switched without covering the composer.
7. Cancel document/photo selection, deny camera permission, and try a file exceeding the displayed limit. **Expected:** The draft is preserved and limits/permissions have useful feedback.
8. Select a temporary file, leave the app, and return before sending. **Expected:** It either uploads or asks for re-selection clearly; there is no endless retry of an unreadable local file.

**Attachment matrix — record a result in every cell:**

| Test asset | Post | Comment | Reply | Server message | DM |
| --- | --- | --- | --- | --- | --- |
| PDF | ___ | ___ | ___ | ___ | ___ |
| DOC | ___ | ___ | ___ | ___ | ___ |
| DOCX | ___ | ___ | ___ | ___ | ___ |
| XLS | ___ | ___ | ___ | ___ | ___ |
| XLSX | ___ | ___ | ___ | ___ | ___ |
| PPT | ___ | ___ | ___ | ___ | ___ |
| PPTX | ___ | ___ | ___ | ___ | ___ |
| Photo | ___ | ___ | ___ | ___ | ___ |
| Video, if offered by this composer | ___ | ___ | ___ | ___ | ___ |
| GIF | ___ | ___ | ___ | ___ | ___ |
| Link, no title | ___ | ___ | ___ | ___ | ___ |
| Link, with title | ___ | ___ | ___ | ___ | ___ |

Use IDs such as FILE-PDF-REPLY in the result log. A Google Docs address is a link; it is not a local .docs file. For a failed cell, save the filename, size, surface, error text, and video timestamp. Do not label an HTTP 413 or unreadable-file error as an offline error without evidence.

### 13 — Feed polls

**Account:** Poll creator, Student A, Student B.

**Say:** “Polls let users vote and, when enabled, add choices. We will test voting rules, the duration, and what happens when voting closes.”

**Show and check:**

1. Open Create Poll. Try a missing question, insufficient choices, and invalid duration. **Expected:** Invalid drafts cannot publish.
2. Create “VIDEO TEST: Preferred activity?” with choices, optional image, and a duration using Days, Hours, and Minutes. **Expected:** Settings and image persist.
3. Vote from both accounts on a single-answer poll; change a vote if the interface permits. **Expected:** Totals/results match valid selections and repeated taps do not inflate votes.
4. Create a multiple-answer poll and test its configured selection limit. **Expected:** Users cannot exceed that limit.
5. Enable user-added options. Add a valid option, then try blank/duplicate content. Repeat with the setting disabled. **Expected:** Valid additions work only while permitted; feedback uses the correct success/error state.
6. Open an expired poll. **Expected:** Results remain readable and new voting/option additions are blocked.
7. Test the creator's available edit/delete controls and confirmation. **Expected:** Permissions and any restrictions after votes are enforced; cancel does not change the poll.

### 14 — Profiles, bookmarks, pinned content, and announcements

**Account:** Student A and authorized staff.

**Say:** “We will check personal profiles and saved content. We will also test how important posts and announcements are shown.”

**Show and check:**

1. Open your Profile and another user's profile. **Expected:** Name, photo, role, and visible content belong to the correct person.
2. Open the same profile from search, a post author, a tag, a mention, and a notification. **Expected:** All routes resolve the same real account.
3. Bookmark a post, open Bookmarks, and remove it from saved items. **Expected:** Saving survives relaunch; removal updates the saved list without deleting the post itself.
4. As authorized staff, pin a test post with a duration. Open the pinned bar and Pinned Posts screen. **Expected:** The same pinned item is accessible and opens the correct post.
5. Unpin it; check a prepared expired pin. **Expected:** Neither remains actively pinned. A student cannot use staff-only pin controls.
6. Open an announcement through the announcement display. **Expected:** The right content opens and its swipe/tap behavior remains usable.

## Chapter C — Communities and messaging

### 15 — Communities and join requests

**Account:** Student A, several requesting students, and authorized community staff.

**Say:** “We will open a community, request access, and review requests from the staff account. The request list should stay clear even when many users are waiting.”

**Show and check:**

1. Open the server/community drawer, find a test community, and inspect its details. **Expected:** Name, icon, description, membership, and access state are correct.
2. Request to join from a nonmember account, then try again. **Expected:** One request is created, the success state is green, and duplicate requests are prevented.
3. Prepare at least four requests. **Expected:** The community shows at most two previews and a View all requests button with an accurate count.
4. Open all requests; search, select several, deselect one, and inspect a requester's profile. **Expected:** Selection/counts are accurate and profile navigation works.
5. Accept selected requests, then reject another selected group. Test Cancel first. **Expected:** Only confirmed selected requests change; membership/access updates on the requesting phones.
6. Attempt restricted community/channel access before and after approval. **Expected:** Membership and program/audience restrictions are enforced.

### 16 — Server messages, replies, and channel polls

**Account:** Two students in an allowed channel and authorized staff.

**Say:** “Inside a server channel, we will send messages, reply to a specific message, and test polls and shared content.”

**Show and check:**

1. Send text in a student-writable channel and receive it on the second phone. **Expected:** It appears once with the correct author and time.
2. Reply using the available reply control. Open the reply reference and try a reply to media. **Expected:** The reply targets the correct original; removed originals are handled gracefully.
3. Complete the server column of the file/link/GIF matrix. **Expected:** File cards and full URLs are clear and receivers can open them.
4. Test named mentions, @everyone, @bea, confirmed people tags, See more, and anonymity. **Expected:** The behaviors in scenes 08–09 hold in channels too.
5. Exercise available own-message edit/delete, reactions, and copy controls. **Expected:** The selected message is affected and cancel does not change it.
6. Create a channel poll with Days/Hours/Minutes, multiple answers, and user-added options. **Expected:** Duration, valid voting, duplicate/empty option checks, disabled additions, and expiry behave correctly.
7. Attempt student posting in a restricted rules/announcement channel. **Expected:** The configured restriction is respected.
8. Interrupt an attachment upload. **Expected:** Feedback refers to a server message, not “Failed to post comment”; recovery does not create duplicates.

### 17 — Community and channel management

**Account:** Administrator, teacher, moderator, and student.

**Say:** “Staff can manage communities within their permissions. We will check channel management and the ability to remove inappropriate student messages, including attached files.”

**Show and check:**

1. Create a disposable community and update its name, description, and supported icon/photo. **Expected:** The saved details appear consistently.
2. Create and edit the available channel types. Delete a disposable channel after cancelling once. **Expected:** Changes affect the selected channel and follow staff permissions.
3. Remove a test member through the permitted control. **Expected:** The member loses restricted access; other members are unaffected.
4. As teacher and moderator, delete separate student-authored text, photo, video, GIF, link, file, and reply examples. **Expected:** Allowed deletions work for every content type, not just text.
5. Attempt to edit another person's message and use restricted deletion against staff-authored content. **Expected:** The actual role rules are enforced; teacher/moderator access is not treated as unrestricted admin access.
6. Submit a server-deletion request where that is the staff flow. Review it as admin: reject one, approve a disposable one. **Expected:** Requests and decisions update correctly and approved removal handles old links safely.

### 18 — Start a DM, send, read, and type

**Account:** Student A, Student B, and a student with no previous conversation.

**Say:** “Opening someone's profile should not create an empty chat. We will send the first message, check unread status, and watch typing and presence from the other phone.”

**Show and check:**

1. Open a person from Messages, then go back without sending. Repeat through User Profile's message icon. **Expected:** No new conversation appears in the inbox.
2. Send the first text to a new contact. **Expected:** One conversation appears for both participants with a correct preview.
3. With a different new contact, send a link as the first-ever message. Repeat in an existing conversation. **Expected:** Both succeed; the URL is visible and the inbox recognizes “Sent a link.”
4. Receive a message while outside the chat, then open it and return to the inbox. **Expected:** The unread/bold state clears when read and the sender sees the appropriate sent/read state.
5. Type from Phone B, stop, send, then leave the conversation. **Expected:** Typing appears for Phone A and clears when appropriate.
6. Move Phone B between active, background, and signed-out states. **Expected:** The green-dot Active and offline/last-seen labels eventually reflect actual state; record the delay rather than requiring an exact instant update.
7. Type @ and select the chat partner. **Expected:** It inserts the correct person and does not offer unrelated people as ordinary DM mentions.
8. Use camera, photo selection, emoji, GIF, file, and link tools. **Expected:** The draft and received result match; the message bar remains above the keyboard.

### 19 — DM replies, search, and message actions

**Account:** Student A and Student B; another contact for forwarding.

**Say:** “Next, we test the actions inside a conversation: replies, edits, copying, reactions, forwarding, pinned messages, and searching older history.”

**Show and check:**

1. Swipe a message to reply, cancel, then reply again and send. **Expected:** The correct quoted message appears and the gesture does not leave the bubble displaced.
2. Tap the reply target above the composer and the reference in a sent reply. **Expected:** Each jumps to the original message when available, including an older message.
3. Edit an owned text message. **Expected:** The update and edited indication reach both phones; Student B cannot edit Student A's message.
4. Copy text and a link and paste into a harmless draft. **Expected:** The actual text/URL is copied accurately.
5. Add, change, and remove a reaction; forward a test message to the selected contact. **Expected:** Reactions are consistent and forwarding sends once to the intended recipient.
6. Pin a message, jump to it, and unpin it. **Expected:** Pinned controls and references stay consistent.
7. Search for a recent phrase, an old phrase beyond the initial loaded history, and nonexistent text. **Expected:** Full-history matches can be reached and no-result search is clear.
8. Use the available message-deletion action after cancelling once. **Expected:** The scope stated in the confirmation matches what disappears on each phone; remaining reply references do not crash.

### 20 — DM inbox, archive, deletion, and chat settings

**Account:** Student A and Student B.

**Say:** “We will organize a conversation, change its settings, and confirm what archive and delete do for each participant.”

**Show and check:**

1. Search contacts/conversations and pin then unpin a conversation. **Expected:** Correct results and inbox ordering persist.
2. Archive a conversation, open Archived, and unarchive it. **Expected:** It moves between the appropriate lists without deleting the conversation.
3. Archive again and have the other person send a new message. **Expected:** The conversation returns to the normal inbox according to the intended archive behavior.
4. Delete the conversation for Student A: cancel first, then confirm. **Expected:** It disappears for A; B still has their side and can read/send.
5. Send a new message from B after A's deletion. **Expected:** The conversation reappears for A with the new message; old history follows the deletion cutoff instead of being unexpectedly restored.
6. Change Chat Theme, Quick Reaction, and nickname. **Expected:** Each setting applies as described and survives reopening without changing the person's real profile name.
7. Mute the conversation, test a background message, then unmute and repeat. **Expected:** Notification behavior follows mute state; the message itself still arrives.
8. Inspect Shared Content: Media, Files, Links, and Pinned Messages. **Expected:** Items open the correct content and removed items are handled gracefully.

### 21 — Notifications and opening the target

**Account:** Student A, Student B, staff; two phones.

**Say:** “We will check the notification list and phone push notifications. Direct messages should still send push notifications, but they should not fill the general notification list.”

**Show and check:**

1. Trigger real test likes/comments/replies/mentions and available event/server notifications. **Expected:** Relevant recipients receive correctly described items without unnecessary duplicates.
2. Use list filters, open one unread item, and mark all read. **Expected:** Read styling and counts update consistently.
3. Open targets for a post, comment, reply, server item, poll, and event when that notification type is supported. **Expected:** The intended content opens, including older content.
4. Tap author, @mention, and tagged names after jumping from a notification. **Expected:** Correct profiles open without a false “user not found.”
5. Open anonymous targets as a student and staff member. **Expected:** The anonymous ID has no unwanted space and identity visibility follows role permissions.
6. Delete a target, then open its old notification. **Expected:** A clear unavailable state appears without a crash or wrong destination.
7. Send a DM while the recipient is backgrounded. **Expected:** An allowed, unmuted push arrives and opens the correct chat; no DM row is added to the general Notifications list.
8. Repeat push opening with the app foregrounded, backgrounded, and normally closed. Test permission denied and later enabled. **Expected:** Routing and settings are respected; record OS restrictions if they block delivery.

## Chapter D — Events, assistant, live video, and support

### 22 — Browse the event calendar

**Account:** Student A, with events for different audiences.

**Say:** “The calendar helps users find school activities. We will check dates, event details, and who can see each event.”

**Show and check:**

1. Open Event Calendar and switch its available calendar/list views. Navigate months and return to today. **Expected:** Date selection and visible events stay aligned.
2. Use program/audience and available status filters. **Expected:** Only matching accessible events are shown.
3. Open an upcoming, ongoing, ended, and cancelled event. **Expected:** Status, location, dates, and times are understandable and correct for the device's time zone.
4. Open an event with several sub-events. **Expected:** Every part is readable with its own correct details.
5. Test a day with no events and an old event notification. **Expected:** Empty/missing states are clear rather than blank or misleading.

### 23 — Create and manage events

**Account:** Authorized event manager and Student A.

**Say:** “We will create an event with several parts, test optional end dates, and check that event forms work while the keyboard is open.”

**Show and check:**

1. Open Create Event and try missing required information. **Expected:** The form explains what is needed before publication.
2. Enter title, venue, details, audience, and start date/time. Leave the optional end date empty. **Expected:** The saved event uses the start date as the end date where required, while still enforcing a valid time range.
3. Test a multi-day event, all-day setting where available, and an end before the start. **Expected:** Valid schedules save; impossible ranges are rejected.
4. Add several sub-events, edit a middle one, and remove a disposable one. **Expected:** The remaining order/details stay intact.
5. Type long details, titles, and venues at the bottom of the form. **Expected:** The keyboard does not cover the active field or required controls.
6. Save a draft, reopen it, and publish. **Expected:** Draft visibility is restricted and publication preserves the data.
7. Edit, cancel, and restore test events. Exercise the offered notify-users choice. **Expected:** Status and notifications match the chosen action; confirmations use the app's designed dialogs.
8. Archive/delete disposable events using the offered controls. **Expected:** Confirmation protects against accidental changes and parent/sub-event links do not become broken visible records.

### 24 — B.E.A. assistant

**Account:** Student A; staff prepares known school test data.

**Say:** “B.E.A. helps users ask questions. We will compare school answers with information saved in the system and check history, follow-up questions, and unavailable information.”

**Show and check:**

1. Open B.E.A. and its suggested questions. Type a greeting and a simple calculation. **Expected:** Input, loading, and replies appear normally; the chat bar remains visible.
2. Ask about a known upcoming event, program, campus FAQ, announcement, and a test Lost & Found item. **Expected:** Answers agree with authorized source records and applicable audience restrictions.
3. Ask a follow-up such as “Where will it happen?” after an event question. **Expected:** The answer uses the intended conversation context rather than a different event.
4. Ask for a school fact that has not been provided. **Expected:** B.E.A. acknowledges uncertainty instead of inventing official names, policies, or dates.
5. Ask for another person's private recovery email and password. **Expected:** No private account details are exposed.
6. Start a new chat, open conversation history, load older history, and return to an old chat. **Expected:** Conversations remain separate and persist correctly.
7. Test feedback, clear-chat, delete-conversation, and offered help/escalation controls. Cancel a deletion first. **Expected:** Only the chosen action affects the chosen chat, and help opens the correct flow.
8. Disconnect during a question, reconnect, and retry. **Expected:** A useful loading/error state appears and no duplicate reply is silently created.
9. Ask @bea in a supported DM/server/comment context. **Expected:** Any supported response appears in the correct conversation/thread without an unwanted people-tag row.

### 25 — Live video and replay

**Account:** Host, Student B as viewer, and authorized live moderator; installed native builds.

**Say:** “We will start a short live session and join from another phone. We will test sound, comments, hearts, viewer activity, and the choice to save or discard a replay.”

**Show and check:**

1. Open Go Live. Try missing required details and denied camera/microphone permission, then grant permission. **Expected:** Guidance is clear and a failed start does not leave a fake active stream.
2. Start “VIDEO TEST Live.” Join from Phone B. **Expected:** The viewer receives live video/audio, the timer is sensible, and the feed opens the right live session.
3. Switch camera, mute/unmute the mic, and pause/resume camera. **Expected:** The viewer's actual media matches the host's displayed control state.
4. Join/leave with test viewers, send comments, and tap hearts. **Expected:** Join activity, viewer counts, comments, and heart totals update without uncontrolled duplicates.
5. Use permitted comment pin/hide and live moderation controls on test content. **Expected:** Authorized actions work and ordinary viewers cannot perform staff-only actions.
6. Background or disconnect the host briefly. **Expected:** The viewer gets an understandable state and a dead stream does not remain live indefinitely.
7. End a test live and choose save replay. Keep the app open during saving. **Expected:** Progress and any review state are visible; the resulting replay opens, plays with audio, and respects the current replay-duration limit shown by the app.
8. End a second live and choose not to save. **Expected:** The live ends without creating a replay post.
9. Interrupt replay uploading and use its recovery/retry path. **Expected:** The app reports failure truthfully and recovery does not create duplicate replay posts.

### 26 — Edit profile, settings, and themes

**Account:** Student A.

**Say:** “We will change profile information and display settings, then reopen the app to check that the changes are saved.”

**Show and check:**

1. Open Edit Profile. Change the photo using gallery and camera, cancelling once. **Expected:** Preview, Save Photo, and saved profile image behave correctly across screens.
2. Change personal email. Test invalid format, wrong code, and valid verification. **Expected:** An unverified address cannot silently replace the verified email.
3. Change a self-chosen password through the optional settings/profile flow. Try an incorrect current password and mismatched new passwords first. **Expected:** Validation works and the final new password signs in.
4. Type in every email, password, and code field. **Expected:** Focused controls remain visible above the keyboard.
5. Open Theme. Apply available Light, Dark, and Campus Colours choices. **Expected:** Preview and final theme match, persist after relaunch, and retain readable text/icons.
6. Change available push and sound settings, then receive a test notification. **Expected:** Delivery and sound respect app settings and device permission state.
7. Open Help & Support and sign out through the offered controls. **Expected:** Navigation and session cleanup work; returning does not show another user's cached private data.

### 27 — User support tickets

**Account:** Student A, Student B, and support staff.

**Say:** “A user can report an issue to support. We will submit a ticket and follow a reply from the support team.”

**Show and check:**

1. Open Help & Support. Try missing subject/details, then submit a test issue in an appropriate category. **Expected:** Validation works and one ticket is created.
2. Add a permitted screenshot/attachment and open it from the ticket. **Expected:** It belongs to the correct ticket and displays properly.
3. Reopen the user's ticket list and its conversation. **Expected:** Reference, status, dates, and messages persist.
4. Reply as staff in scene 34, then return as the user. **Expected:** The reply and unread/status indicators update correctly.
5. Disconnect during submission/reply and retry after reconnecting. **Expected:** Useful error handling and no accidental duplicate tickets/messages.
6. As Student B, try to access Student A's private ticket through a shared test target. **Expected:** Access is refused; Student B cannot read it.

## Chapter E — Staff and administration

### 28 — Register users and manage programs

**Account:** Administrator; student for denied-access checks.

**Say:** “We will register test users and manage program information. Required fields and duplicate records should be checked before saving.”

**Show and check:**

1. Open user registration. Try empty fields and an existing school ID. **Expected:** Invalid/duplicate entries are blocked with clear feedback.
2. Register a test student with valid name, ID, program, and year. **Expected:** One account is created and User Registered uses a green success design.
3. Register a test teacher with its supported position details. **Expected:** Role-specific fields and resulting access are correct.
4. Import a small valid user file using the screen's required template. Then import mixed valid/invalid rows. **Expected:** All-success is green; partial failure is amber with useful counts/details. Existing users are not duplicated.
5. Sign in as the new student. **Expected:** Temporary-password and profile-setup requirements match scene 03.
6. Open Manage Programs. Add, search, edit, and attempt a duplicate program code. **Expected:** Valid changes persist and duplicates are handled clearly.
7. Delete only a disposable unused program, cancelling first. **Expected:** The correct record is affected and referenced data is not silently damaged.
8. Attempt these screens/actions as a student. **Expected:** Admin-only capabilities are denied.

### 29 — Manage users and account recovery

**Account:** Administrator and disposable test accounts.

**Say:** “We will find and edit user records, then test account recovery controls using test accounts only.”

**Show and check:**

1. Search by name, school ID, and supported private/admin fields; use role/program/year/online filters and load more. **Expected:** Results and counts match the selected filters.
2. Edit permitted name, program, year, role, and permission fields. Cancel once before saving. **Expected:** Only saved changes persist; role changes take effect on the affected account.
3. Type in first name, last name, and lower form fields. **Expected:** The keyboard does not hide the active input or save controls.
4. Reset a disposable account to a temporary password. **Expected:** Existing password stops working, old sessions are ended as designed, and the user must choose a new password at sign-in. Hide the temporary password in the public video.
5. Remove the recovery email from that test account. **Expected:** It must add/verify a new email before normal access; old recovery details are no longer used.
6. Use Sign out all devices, then Lock and Unlock account. **Expected:** Sessions/access change as described, unlock restores permitted sign-in, and recovery history records each action.
7. Check protections for the current administrator and restricted role/permission changes. **Expected:** The administrator cannot accidentally use actions prohibited by the interface/rules.
8. If testing the legacy “Make personal emails private” migration, use a separate test dataset containing legacy records. **Expected:** Eligible data moves correctly, running again is safe, owner/admin access remains, and ordinary users cannot read someone else's private email. Record this as BLOCKED if no safe test dataset is available.

### 30 — Year promotion

**Account:** Administrator; isolated promotion test dataset only.

**Say:** “Year promotion changes many student records, so we are testing it with prepared sample students. We will compare the preview with the actual result.”

**Show and check:**

1. Open Year Promotion with sample students in different years and one on promotion hold. **Expected:** The preview separates eligible, held, and graduating records correctly.
2. Try a past schedule time, then schedule a future run. Cancel that schedule. **Expected:** Invalid time is rejected and cancelling prevents that run.
3. Choose Run now on the test dataset. **Expected:** It schedules backend processing and shows progress/status honestly; it does not claim immediate completion before processing finishes.
4. After completion, inspect each sample. **Expected:** Eligible students advance once, final-year students become graduated, and held/ineligible accounts remain unchanged.
5. Check results/history and duplicate/retry handling for the same job. **Expected:** Retrying a job does not promote students twice; the result explains any failure.
6. Try the screen as a non-admin. **Expected:** Access is denied. If scheduled backend processing is unavailable, mark the execution tests BLOCKED rather than PASS.

### 31 — Dashboard and analytics

**Account:** Administrator and other authorized staff.

**Say:** “The dashboard and analytics help staff understand activity. We will compare the displayed numbers with known actions from our test accounts.”

**Show and check:**

1. Open Dashboard and each visible management shortcut. **Expected:** Every card opens the correct authorized screen.
2. Inspect totals, role/program/year breakdowns, online users, and available filters. **Expected:** Labels and numbers are consistent with the prepared dataset and filter scope.
3. Open a listed user's profile. **Expected:** It resolves the correct account without a false missing-user error.
4. Review the pending server-deletion requests from scene 17. **Expected:** Counts, approval, and rejection states agree with the actual requests.
5. Open Analytics and change its available date ranges. Inspect activity, posts/flairs, roles, reports, and moderation/safety summaries. **Expected:** Charts have readable labels and correct empty states; they do not invent values when data is unavailable.
6. Create a known test action and compare after the documented refresh/aggregation period or permitted manual refresh. **Expected:** Counts reflect the action once; note aggregation delay rather than calling delayed data immediately wrong.
7. Try admin/staff-only analytics from a student account. **Expected:** Access follows the configured role rules.

### 32 — Moderation, reporting, and staff deletion

**Account:** Eligible student reporter, teacher, moderator, administrator.

**Say:** “We will submit a sample report and review prepared moderation items. We will also test that staff permissions apply to the correct content and author roles.”

**Show and check:**

1. Use the report control on eligible sample student/anonymous content, choose a reason, and submit. **Expected:** One report reaches the queue; unavailable reporting options follow the app's role/content rules.
2. Open Report Management, filter/search, inspect the original item, and use supported resolve/dismiss/reopen actions. **Expected:** Status and counts update without changing unrelated reports.
3. Open a report whose content was deleted. **Expected:** The report remains understandable and does not crash.
4. Open Manage Moderation with harmless prepared pending/flagged fixtures for the supported content types. **Expected:** Content, reasons, and review status are visible and filters/load-more work.
5. Approve permitted items and delete/reject disposable items; test selected/bulk actions where offered. **Expected:** Only intended items change after confirmation and public visibility matches the decision.
6. Check a student cannot perform staff actions. Check teacher/moderator deletion of student content and restrictions on staff-authored content. **Expected:** The author/role rules are enforced consistently.
7. Open a prepared blocked-media/safety state. **Expected:** The app explains the result and offers its intended support path without falsely claiming upload success. Do not create harmful material just to trigger a test.

### 33 — Campus FAQ and AI memory

**Account:** Administrator for Campus FAQ; authorized staff for AI Memory.

**Say:** “Staff can maintain school information used by B.E.A. We will add a clear test answer, update it, and check that information is used only in its intended scope.”

**Show and check:**

1. Open Manage Campus FAQ as admin. Add a uniquely named question and answer; try missing fields. **Expected:** Validation works and a valid entry appears in search.
2. Edit that answer, select records, cancel deletion, then delete disposable entries. **Expected:** Only confirmed selected entries change.
3. Exercise the built-in-answer import on an isolated test dataset if pending entries exist. **Expected:** The import count is correct and existing entries are not duplicated.
4. Open AI Memory. Add/edit a harmless test fact using the offered scope, priority/tags, and active setting. **Expected:** Data persists and the saved scope is clear.
5. Ask B.E.A. the matching test question using an eligible and an ineligible account. **Expected:** The response respects access scope and active status. Allow for configured caching before verifying edits.
6. Disable/delete the disposable fact and recheck after the applicable refresh period. **Expected:** Removed/inactive information is no longer treated as active knowledge.
7. Attempt FAQ management as non-admin and AI-memory management without permission. **Expected:** Access is denied according to each tool's role rules.

### 34 — Support management

**Account:** Authorized support administrator/staff and Student A.

**Say:** “We will answer the support request created earlier and check that the user receives the response and correct ticket status.”

**Show and check:**

1. Open Manage Support and find the scene 27 ticket by reference, name, or subject. **Expected:** It appears once with the correct details.
2. Use available Waiting on us, Open, In progress, Resolved, Closed, and All filters. **Expected:** Each list matches its status/queue definition.
3. Open the screenshot/attachment and conversation. Reply as support. **Expected:** The correct user receives the response, with consistent unread indicators.
4. Exercise available priority, assignment, and status controls. **Expected:** Only authorized changes persist and the user's visible status is accurate.
5. Resolve/close a disposable ticket; test the offered reopen/follow-up behavior. **Expected:** The flow follows its displayed rules and preserves the conversation history.
6. Find the Sign-in Help request from scene 04. **Expected:** Staff can identify and handle it through the supported workflow without exposing it to unrelated users.
7. Attempt unauthorized queue and ticket access. **Expected:** Private support details are not exposed.

## Chapter F — Shared checks and results

### 35 — Keyboard, device, network, and performance regression

**Account:** Repeat with student and staff screens as appropriate.

**Say:** “For the final checks, we test the app under less ideal conditions. We will open the keyboard, deny a permission, interrupt the connection, and check the installed APK on another phone.”

**Show and check:**

1. Complete the keyboard matrix below with short and long input. **Expected:** The focused field, suggestions, and required action can be reached while typing; dismissing the keyboard restores layout.
2. Test system status/navigation areas, larger text, light/dark themes, and a smaller screen. **Expected:** Key text and buttons remain readable and reachable; success/error states are not communicated by color alone.
3. Use Android Back, modal close, swipe-down where offered, and reopen each major sheet. **Expected:** No trapped overlay, missing composer, or accidental navigation to the wrong screen.
4. Deny then grant camera, photo/media, microphone, and notification permissions where requested. **Expected:** Each flow explains the missing permission and recovers after permission is granted.
5. Disconnect while loading a feed, sending text, uploading a file, saving a form, and asking B.E.A. **Expected:** Clear loading/offline/failure states; reconnect/retry does not silently duplicate records or falsely mark failed work complete.
6. Tap Send/Save twice quickly and navigate away/back during a request. **Expected:** Duplicate actions are prevented or safely handled; there are no stuck buttons or unexpected repeated records.
7. Relaunch and switch between test accounts. **Expected:** Saved work persists, draft behavior is understandable, and one user's private data is not shown to another.
8. On the release APK, measure cold launch, Home load, typing response, long-feed scrolling, large chat history, and repeated GIF/media opening. **Expected:** Record actual times and visible stalls on each device; compare with the team's agreed limits and capture any regression.
9. Inspect battery/heat and memory/crash behavior during an extended media/live session. **Expected:** No crash or steadily worsening responsiveness. Log the duration and device conditions instead of claiming a performance improvement without measurements.

**Keyboard and layout matrix:**

| Screen/control | Check while typing | Result |
| --- | --- | --- |
| Login and Forgot Password | Password, eye icons, code, action button | ___ |
| Profile Setup | Email, verification code, each password field, rules actions | ___ |
| Edit Profile | Email/code/password controls and photo sheet | ___ |
| Create/Edit Post | Long text, @ suggestions, tags, link URL/title | ___ |
| Comment composer | Text, @ selection, link title, tag search/Confirm | ___ |
| Reply composer | Text, @ selection, link title, tag search/Confirm | ___ |
| Server composer | Text, @ selection, link title, tag search/Confirm | ___ |
| DM composer | Multiline text, reply preview, links, emoji/GIF switching | ___ |
| B.E.A. | Input bar after history, keyboard, and screen switching | ___ |
| Poll forms | Question, bottom option, duration dropdowns | ___ |
| Event forms | Details, venue, extra sub-events, bottom actions | ___ |
| Registration/Manage Users | First/last name, search, lower edit fields | ___ |
| FAQ/AI Memory | Long question/answer/fact and save button | ___ |
| Support/Sign-in Help | Subject/details, replies, attachment controls | ___ |
| Live comments | Typing without covering essential live controls | ___ |
| Global sheets | GIF header below status bar; buttons above phone navigation | ___ |

**Checks requiring technical evidence in addition to the video:** A tester with access to the test backend should verify stored setup/rules acceptance version and date, actual role/access denial, private-email access rules, conversation creation/deletion state, promotion job results, and push/background processing logs. Do this against test data using the team's existing tools. A screen recording of a hidden button is not proof that the backend rejects an unauthorized write. These checks remain BLOCKED until evidence is collected if the team cannot inspect them.

### 36 — Results and closing

**Say:** “This completes our BondED test recording. We checked the app using student and staff accounts, including communication, files, events, live video, support, and administration. Our result log shows which checks passed, which failed, and which could not be completed. We will retest the failed checks after the fixes.”

**Show and check:**

1. Show the completed result log, not a prefilled claim that everything passed.
2. State the tested APK version and device names. Mention any service or device limitations that blocked a test.
3. Show one example of the evidence recorded for a failure: action, expected result, actual result, and clip timestamp.
4. State the next retest items. Keep actual passwords, verification codes, and real private user information out of the public edit.

**Optional closing when every required check really passed:** “All required checks in this recorded run passed on the listed build and devices.” Do not use this sentence when required tests are failed, blocked, or unrun.

## Result log template

Copy one row for each numbered step and each matrix cell. For a step containing several variants, use suffixes such as 03.4-wrong-code and 03.4-expired-code so a successful variant does not hide a failure.

| Test ID | Build/device/account | Expected result | Actual result | PASS / FAIL / BLOCKED / N/A | Clip + timestamp | Issue/retest reference |
| --- | --- | --- | --- | --- | --- | --- |
| 03.2 | ___ | Required photo selection works | ___ | ___ | ___ | ___ |
| FILE-PDF-REPLY | ___ | PDF sends and opens for receiver | ___ | ___ | ___ | ___ |
| 18.1 | ___ | No empty DM conversation created | ___ | ___ | ___ | ___ |
| 21.7 | ___ | DM push arrives; no general notification row | ___ | ___ | ___ | ___ |
| ___ | ___ | ___ | ___ | ___ | ___ | ___ |

Suggested clip naming: `BondED_BUILD_Scene18_PhoneA.mp4`. Write both phones' timestamps for real-time tests. Preserve the failing clip and create a separate retest clip after a fix.

## Screen coverage index

This index covers the screen routes present in the project when this script was prepared. Navigation layouts and reusable components are covered by their user-facing scenes. New features added later need new tests.

| App screen | Scene(s) |
| --- | --- |
| LoginScreen | 01–02 |
| ProfileSetupScreen | 03 |
| ForgotPasswordScreen | 04 |
| SignInHelpScreen | 04, 34 |
| HomeScreen | 05–14, 25 |
| CreatePostScreen | 06–09, 12 |
| CreatePollScreen | 13 |
| ProfileScreen | 14, 26 |
| UserProfileScreen | 08–09, 14, 18, 21 |
| BookmarksScreen | 07, 14 |
| PinnedPostsScreen | 14 |
| MessagesScreen | 18, 20 |
| DirectChatScreen | 12, 18–20 |
| ServerChannelScreen | 08–12, 15–17 |
| NotificationsScreen | 21 |
| NotificationTargetScreen | 09, 11, 21 |
| EventCalendarScreen | 22–23 |
| CreateEventScreen | 23 |
| AiChatScreen | 24 |
| GoLiveScreen | 25 |
| LiveStreamScreen | 25 |
| EditProfileScreen | 26 |
| SettingsScreen | 21, 26 |
| ThemeScreen | 26, 35 |
| SupportScreen | 27 |
| SupportTicketScreen | 27, 34 |
| AdminRegisterUserScreen | 28 |
| AdminManageProgramsScreen | 28 |
| ManageUsersScreen | 29 |
| YearPromotionScreen | 30 |
| DashboardScreen | 17, 31 |
| AnalyticsScreen | 31 |
| ManageModerationScreen | 32 |
| ReportManagementScreen | 32 |
| ManageCampusFaqScreen | 33 |
| AiMemoryScreen | 33 |
| ManageSupportScreen | 34 |

Reusable UI covered separately: community drawer and join-request sheet; comments and reply threads; tag/mention pickers; file cards; GIF/emoji pickers; link dialog; photo source sheet; image viewer; video controls; media carousel; poll cards; pin-duration sheet; confirmation and safety dialogs; and live activity controls.

## Short introduction for the edited presentation

“Good day, everyone. This video shows our testing of BondED. We use different accounts to check what students, teachers, moderators, and administrators can do. We test normal actions, incorrect inputs, and connection problems. For each part, we compare what should happen with what actually happens. The full test results are listed in our testing log.”

The edited presentation can show one clear example per chapter. Keep the complete scene recordings and matrix results as the evidence for wider coverage.
