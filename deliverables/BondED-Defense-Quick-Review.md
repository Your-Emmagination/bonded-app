# BondED: My Defense Answers

Short answers to practice aloud. "We" means our team. The memory cues help you remember the main idea.

## 1. Why did you choose this technology?

We chose React Native with Expo because BondED is a mobile app and these tools help us build and test it. Firebase handles sign-in and real-time data. Cloudinary stores our media, and Cloudflare runs our backend tasks. My main reasons were cost, the features we needed, our team's skills, and how easy the system would be to maintain.

**Remember:** Mobile app - real-time data - cost - maintenance.

**If asked further:** Acquisition criteria means how we compared tools: cost, required features, team skills, documentation, and maintenance. BondED uses Firestore, a document database, rather than MySQL.

## 2. What if the number of users doubles?

If our users double, I would first check which part becomes slow or reaches its limit. We can load records in smaller groups, improve database queries, and increase our cloud service limits when needed. Our app, backend, database, and media storage are separate, so we can improve each part without rebuilding everything. We still need load testing to confirm the capacity.

**Remember:** Measure - improve queries - increase capacity - test.

**If asked further:** Do not promise that growth is automatically free or that the app already passed a large-scale load test. Firestore reads, media delivery, and live viewers affect capacity and cost.

## 3. What are the benefits and the 3- to 5-year cost?

The main benefit of BondED is having school announcements, messages, events, and support in one app. This can reduce the time spent checking different channels. For the cost, I would include cloud services, internet, maintenance, and technical support. Some services have free limits, but costs can grow with usage. We do not yet have a confirmed three- to five-year total or measured financial return.

**Remember:** One place - time saved - operating costs - actual usage.

**If asked further:** TCO means the full cost of owning and maintaining the system. Three-year TCO = setup cost + 36 months of operating costs + maintenance and contingency. Use 60 months for five years. Do not repeat the original document's peso estimate or 14-month ROI as a verified BondED result. Count development time and existing equipment as resources even when no new cash was paid.

## 4. How do you stop students from accessing admin features?

BondED has four roles: student, teacher, moderator, and administrator. Each role has different permissions. Firebase checks the signed-in user, while Firestore rules and backend checks protect restricted actions. For example, a student cannot gain account-management permission just by opening an admin screen. We check access where the data is read or changed, as well as in the app interface.

**Remember:** Four roles - verify user - check permission.

**If asked further:** RBAC means Role-Based Access Control: a person's role determines what they may do. Hiding a button alone is not security. The deployed rules and backend must enforce the permission.

## 5. How do you protect personal information?

We use Firebase Authentication for sign-in and password handling. Firestore rules limit who can read or change data. Our design also keeps personal email and recovery details separate from public profile information. These measures help protect users. For the Data Privacy Act, we also need the school's review of our privacy notice and data-handling procedures; technical features alone do not prove full compliance.

**Remember:** Secure sign-in - limited access - private details - school review.

**If asked further:** Do not claim that BondED itself uses bcrypt or custom AES encryption unless you have implementation evidence. Do not call messaging end-to-end encrypted. Describe the controls you can demonstrate, and present legal compliance as something requiring proper review.

## 6. What is your backup and recovery plan?

Firebase hosts our database, but cloud hosting alone is not a complete backup plan. We still need to confirm automated backups and test a restore. My proposed target is to recover data with no more than 24 hours of loss and restore service within two hours. These are planning targets, not measured results. The recovery plan must also cover uploaded files and backend configuration.

**Remember:** Separate backups - 24-hour loss target - 2-hour recovery target - restore test.

**If asked further:** RPO means how much recent data we can afford to lose. RTO means how long recovery should take. The project files do not establish that automated database backups or a successful timed restore already exist. Confirm the real backup setup with the team before claiming it is operational.

## 7. How will you handle an error or frozen screen?

A user can report the problem through Help and Support, including what they were doing and when it happened. I would try to repeat the issue and check the app or device logs and the relevant backend logs. This helps us find whether the cause is the connection, a permission, or a software bug. We would then fix it, test it, and update the user.

**Remember:** Report - repeat the problem - check logs - fix - test.

**If asked further:** For a frozen app, the user may need to reopen it or contact staff through another channel. Support tickets are user reports. Do not claim every phone crash is automatically captured in one central dashboard; that was not established in this review.

## 8. Where is the system hosted, and how do you update it?

BondED runs as an app on the phone and connects to cloud services. Firebase handles accounts and database records, Cloudinary handles uploaded media, and Cloudflare runs backend tasks. For app updates, we test the changes, build a new APK, and install the updated version. Backend code and database rules are deployed separately. We should keep updates compatible with installed app versions.

**Remember:** Phone app - cloud services - test - new APK.

**If asked further:** APK means the Android installation file. Your current build method uses Gradle on your computer. Do not describe Nginx, blue-green deployment, or guaranteed zero downtime as existing BondED features. Firebase Functions are also present in the repository; mention them as live services only if the team confirms they are deployed.

## 9. What happens if the internet disconnects while sending?

If the connection drops, a submission may stay pending or fail. We validate input and block repeated taps while sending. In direct messages, Firestore transactions save related database changes together. These controls help reduce invalid or duplicate records. After reconnecting, I would check whether the item was saved before sending again. File uploads are a separate step, so a failed upload may need a retry.

**Remember:** Validate - block double taps - save together - check before retry.

**If asked further:** A transaction saves its database changes together or does not commit them. This does not make a Cloudinary upload and a Firestore write one shared transaction. Do not promise full offline operation or zero duplicates across every workflow without testing each case.

## 10. How will you turn over the system to the school?

We plan to train the school's users through a short demonstration and hands-on practice. We would provide a simple user guide with screenshots. For the IT staff, we would turn over the source code, setup guide, service account ownership, role guide, and troubleshooting steps. We would also agree on a support period and identify who will maintain the system after our project ends.

**Remember:** Train users - give guides - turn over access - agree on support.

**If asked further:** Present training and the support period as a plan unless they have already been completed or agreed with the school. Do not promise the original sample's 30-day support period without the team's agreement. Secret credentials should be transferred securely, not printed in the public manuscript.
