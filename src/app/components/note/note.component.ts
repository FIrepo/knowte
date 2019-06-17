import { Component, OnInit, OnDestroy, HostListener, NgZone, ViewEncapsulation } from '@angular/core';
import { remote, BrowserWindow, Clipboard, SaveDialogOptions } from 'electron';
import { ActivatedRoute } from '@angular/router';
import { NoteDetailsResult } from '../../services/results/noteDetailsResult';
import log from 'electron-log';
import { MatDialog, MatDialogRef } from '@angular/material';
import { ChangeNotebookDialogComponent } from '../dialogs/changeNotebookDialog/changeNotebookDialog.component';
import { Constants } from '../../core/constants';
import { Subject } from 'rxjs';
import { debounceTime } from "rxjs/internal/operators";
import { Operation } from '../../core/enums';
import { NoteOperationResult } from '../../services/results/noteOperationResult';
import { SnackBarService } from '../../services/snackBar.service';
import { TranslateService } from '@ngx-translate/core';
import { ErrorDialogComponent } from '../dialogs/errorDialog/errorDialog.component';
import * as Quill from 'quill';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Utils } from '../../core/utils';
import { ConfirmationDialogComponent } from '../dialogs/confirmationDialog/confirmationDialog.component';
import { NoteExport } from '../../core/noteExport';
import { SettingsService } from '../../services/settings.service';
import { ipcRenderer } from 'electron';
import { NoteActionsDialogComponent } from '../dialogs/noteActionsDialog/noteActionsDialog.component';
import { NoteAction } from '../dialogs/noteActionsDialog/noteAction';

@Component({
    selector: 'note-content',
    templateUrl: './note.component.html',
    styleUrls: ['./note.component.scss'],
    encapsulation: ViewEncapsulation.None
})
export class NoteComponent implements OnInit, OnDestroy {
    private saveTimeoutMilliseconds: number = 5000;
    private windowCloseTimeoutMilliseconds: number = 500;
    private quill: Quill;
    private globalEmitter = remote.getGlobal('globalEmitter');
    private noteId: string;
    private isTitleDirty: boolean = false;
    private isTextDirty: boolean = false;
    private noteMarkChangedListener: any = this.noteMarkChangedHandler.bind(this);
    private notebookChangedListener: any = this.notebookChangedHandler.bind(this);
    private focusNoteListener: any = this.focusNoteHandler.bind(this);
    private closeNoteListener: any = this.closeNoteHandler.bind(this);

    constructor(private activatedRoute: ActivatedRoute, private zone: NgZone, private dialog: MatDialog,
        private snackBarService: SnackBarService, private translateService: TranslateService, private settingsService: SettingsService) {
    }

    public initialNoteTitle: string;
    public noteTitle: string;
    public notebookName: string;
    public isMarked: boolean;
    public noteTitleChanged: Subject<string> = new Subject<string>();
    public noteTextChanged: Subject<string> = new Subject<string>();
    public saveChangesAndCloseNoteWindow: Subject<string> = new Subject<string>();
    public isBusy: boolean = false;

    public editorStyle = {
        'font-size': this.settingsService.fontSizeInNotes + 'px'
    }

    public ngOnDestroy(): void {
    }

    public async ngOnInit(): Promise<void> {
        let notePlaceHolder: string = await this.translateService.get('Notes.NotePlaceholder').toPromise();

        let toolbarOptions: any = [
            [{ 'color': [] }, { 'background': [] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'header': 1 }, { 'header': 2 }],
            [{ 'list': 'ordered' }, { 'list': 'bullet' }, { 'list': 'check' }],
            ['link', 'blockquote', 'code-block', 'image'],
            // [{ 'script': 'sub' }, { 'script': 'super' }], 
            // [{ 'indent': '-1' }, { 'indent': '+1' }],   
            // [{ 'direction': 'rtl' }],                      
            // [{ 'size': ['small', false, 'large', 'huge'] }], 
            // [{ 'header': [1, 2, 3, 4, 5, 6, false] }],
            // [{ 'font': [] }],
            // [{ 'align': [] }],
            ['clean']
        ];

        this.quill = new Quill('#editor', {
            modules: {
                toolbar: toolbarOptions
            },
            placeholder: notePlaceHolder,
            theme: 'snow',
        });

        this.quill.on('text-change', () => {
            this.isTextDirty = true;
            this.clearSearch();
            this.noteTextChanged.next("");
        });

        this.activatedRoute.queryParams.subscribe(async (params) => {
            this.noteId = params['id'];

            this.addListeners();
            await this.getNoteDetailsAsync();
            this.applySearch();
        });

        this.noteTitleChanged
            .pipe(debounceTime(this.saveTimeoutMilliseconds))
            .subscribe((finalNoteTitle) => {
                this.globalEmitter.emit(Constants.setNoteTitleEvent, this.noteId, this.initialNoteTitle, finalNoteTitle, this.setNoteTitleCallbackAsync.bind(this));
            });

        this.noteTextChanged
            .pipe(debounceTime(this.saveTimeoutMilliseconds))
            .subscribe(async (_) => {
                this.globalEmitter.emit(Constants.setNoteTextEvent, this.noteId, this.quill.getText(), this.setNoteTextCallbackAsync.bind(this));
            });

        this.saveChangesAndCloseNoteWindow
            .pipe(debounceTime(this.windowCloseTimeoutMilliseconds))
            .subscribe((_) => {
                this.saveAndClose();
            });

        // Image pasting based on: https://gist.github.com/dusanmarsa/2ca9f1df36e14864328a2bb0b353332e
        document.onpaste = (e: ClipboardEvent) => {
            this.handleImagePaste(e);
        }
    }

    public changeNotebook(): void {
        let dialogRef: MatDialogRef<ChangeNotebookDialogComponent> = this.dialog.open(ChangeNotebookDialogComponent, {
            width: '450px', data: { noteId: this.noteId }
        });
    }

    public showNoteActions(): void {
        let dialogRef: MatDialogRef<NoteActionsDialogComponent> = this.dialog.open(NoteActionsDialogComponent, {
            width: '450px', data: { isMarked: this.isMarked }
        });

        dialogRef.afterClosed().subscribe(async (result) => {
            if (result) {
                let noteAction: NoteAction = dialogRef.componentInstance.selectedNoteAction;
                this.handleNoteAction(noteAction);
            }
        });
    }

    private handleNoteAction(noteAction: NoteAction): void {
        switch (noteAction) {
            case NoteAction.Delete: {
                this.deleteNoteAsync();
                break;
            }
            case NoteAction.Export: {
                this.exportNoteAsync();
                break;
            }
            case NoteAction.ExportToPdf: {
                this.exportNoteToPdfAsync();
                break;
            }
            case NoteAction.Print: {
                this.printNote();
                break;
            }
            case NoteAction.ToggleMark: {
                this.toggleNoteMark();
                break;
            }
            default: {
                // Do nothing
                break;
            }
        }
    }

    public onNotetitleChange(newNoteTitle: string) {
        this.isTitleDirty = true;
        this.clearSearch();
        this.noteTitleChanged.next(newNoteTitle);
    }

    @HostListener('document:keydown.escape', ['$event']) onKeydownHandler(event: KeyboardEvent) {
        if (this.settingsService.closeNotesWithEscape) {
            let window: BrowserWindow = remote.getCurrentWindow();
            window.close();
        }
    }

    // ngOndestroy doesn't tell us when a note window is closed, so we use this event instead.
    @HostListener('window:beforeunload', ['$event'])
    public beforeunloadHandler(event): void {
        log.info(`Detected closing of note with id=${this.noteId}`);

        // Prevents closing of the window
        if (this.isTitleDirty || this.isTextDirty) {
            this.isTitleDirty = false;
            this.isTextDirty = false;

            log.info(`Note with id=${this.noteId} is dirty. Preventing close to save changes first.`);
            event.preventDefault();
            event.returnValue = '';

            this.saveChangesAndCloseNoteWindow.next("");
        } else {
            log.info(`Note with id=${this.noteId} is clean. Closing directly.`);
            this.cleanup();
        }
    }

    public onTitleKeydown(event): void {
        if (event.key === "Enter" || event.key === "Tab") {
            // Make sure enter is not applied to the editor
            event.preventDefault();

            // Sets focus to editor when pressing enter on title
            this.quill.setSelection(0, 0);
        }
    }

    public toggleNoteMark(): void {
        this.globalEmitter.emit(Constants.setNoteMarkEvent, this.noteId, !this.isMarked);
    }

    public async exportNoteToPdfAsync(): Promise<void> {
        let options: SaveDialogOptions = { defaultPath: Utils.getPdfExportPath(remote.app.getPath('documents'), this.noteTitle) };
        let savePath: string = remote.dialog.showSaveDialog(null, options);

        if (savePath) {
            let content: any = {
                savePath: savePath,
                text: `<div>${this.createPrintCss()}<p class="page-title">${this.noteTitle}</p><p>${this.quill.root.innerHTML}</p></div>`
            }

            this.sendCommandToWorker("printPDF", content);
        }
    }

    public printNote(): void {
        this.sendCommandToWorker("print", `<div>${this.createPrintCss()}<p class="page-title">${this.noteTitle}</p><p>${this.quill.root.innerHTML}</p></div>`);
    }

    private createPrintCss(): string {
        // Font stacks from: https://gist.github.com/001101/a8b0e5ce8fd81225bed7
        return `<style type="text/css" scoped>
                    * {
                        font-family: Corbel, "Lucida Grande", "Lucida Sans Unicode", "Lucida Sans", "DejaVu Sans", "Bitstream Vera Sans", "Liberation Sans", Verdana, "Verdana Ref", sans serif;
                    }

                    body {
                        -webkit-print-color-adjust:exact;
                    }

                    h1,
                    a {
                        color: #1d7dd4;
                    }

                    h2{
                        color: #748393;
                    }

                    pre {
                        background-color: #f0f0f0;
                        border-radius: 3px;
                        white-space: pre-wrap;
                        margin: 5px 0 5px 0;
                        padding: 5px 10px;
                    }

                    pre.ql-syntax {
                        background-color: #23241f;
                        color: #f8f8f2;
                        overflow: visible;

                        font-family: Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", "Lucida Sans Typewriter", "DejaVu Sans Mono", "Bitstream Vera Sans Mono", "Liberation Mono", "Nimbus Mono L", Monaco, "Courier New", Courier, monospace;
                    }

                    blockquote {
                        border-left: 4px solid #ccc;
                        margin: 5px 0 5px 0;
                        padding: 0 0 0 16px;
                    }

                    .page-title{
                        font-size: 30px;
                    }
                </style>`;
    }

    public async deleteNoteAsync(): Promise<void> {
        let title: string = await this.translateService.get('DialogTitles.ConfirmDeleteNote').toPromise();
        let text: string = await this.translateService.get('DialogTexts.ConfirmDeleteNote', { noteTitle: this.noteTitle }).toPromise();

        let dialogRef: MatDialogRef<ConfirmationDialogComponent> = this.dialog.open(ConfirmationDialogComponent, {

            width: '450px', data: { dialogTitle: title, dialogText: text }
        });

        dialogRef.afterClosed().subscribe(async (result) => {
            if (result) {
                this.globalEmitter.emit(Constants.deleteNoteEvent, this.noteId);

                let window: BrowserWindow = remote.getCurrentWindow();
                window.close();
            }
        });
    }

    public async exportNoteAsync(): Promise<void> {
        this.isBusy = true;

        let options: SaveDialogOptions = { defaultPath: Utils.getNoteExportPath(remote.app.getPath('documents'), this.noteTitle) };
        let savePath: string = remote.dialog.showSaveDialog(null, options);
        let noteExport: NoteExport = new NoteExport(this.noteTitle, this.quill.getText(), JSON.stringify(this.quill.getContents()));

        try {
            if (savePath) {
                await fs.writeFile(savePath, JSON.stringify(noteExport));
                this.snackBarService.noteExportedAsync(this.noteTitle);
            }

            this.isBusy = false;
        } catch (error) {
            this.isBusy = false;
            log.error(`An error occurred while exporting the note with title '${this.noteTitle}'. Cause: ${error}`);

            let errorText: string = (await this.translateService.get('ErrorTexts.ExportNoteError', { noteTitle: this.noteTitle }).toPromise());

            this.dialog.open(ErrorDialogComponent, {
                width: '450px', data: { errorText: errorText }
            });
        }
    }

    private removeListeners(): void {
        this.globalEmitter.removeListener(Constants.noteMarkChangedEvent, this.noteMarkChangedListener);
        this.globalEmitter.removeListener(Constants.notebookChangedEvent, this.notebookChangedListener);
        this.globalEmitter.removeListener(Constants.focusNoteEvent, this.focusNoteListener);
        this.globalEmitter.removeListener(Constants.closeNoteEvent, this.closeNoteListener);
    }

    private addListeners(): void {
        this.globalEmitter.on(Constants.noteMarkChangedEvent, this.noteMarkChangedListener);
        this.globalEmitter.on(Constants.notebookChangedEvent, this.notebookChangedListener);
        this.globalEmitter.on(Constants.focusNoteEvent, this.focusNoteListener);
        this.globalEmitter.on(Constants.closeNoteEvent, this.closeNoteListener);
    }

    private cleanup(): void {
        this.globalEmitter.emit(Constants.setNoteOpenEvent, this.noteId, false);
        this.removeListeners();
    }

    private insertImage(file: any): void {
        let reader: FileReader = new FileReader();

        reader.onload = (e: any) => {
            let img: HTMLImageElement = document.createElement('img');
            img.src = e.target.result;

            let range: Range = window.getSelection().getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
        };

        reader.readAsDataURL(file);
    }

    private handleImagePaste(e: ClipboardEvent): void {
        let IMAGE_MIME_REGEX: RegExp = /^image\/(p?jpeg|gif|png)$/i;

        let items: DataTransferItemList = e.clipboardData.items;

        for (let i: number = 0; i < items.length; i++) {
            if (IMAGE_MIME_REGEX.test(items[i].type)) {
                // The pasted item is an image, so prevent the default paste action.
                e.preventDefault();
                this.insertImage(items[i].getAsFile());

                return;
            }
        }
    }

    private saveAndClose(): void {
        this.globalEmitter.emit(Constants.setNoteTitleEvent, this.noteId, this.initialNoteTitle, this.noteTitle, async (result: NoteOperationResult) => {
            let setTitleOperation: Operation = result.operation;
            await this.setNoteTitleCallbackAsync(result);

            this.globalEmitter.emit(Constants.setNoteTextEvent, this.noteId, this.quill.getText(), async (operation: Operation) => {
                let setTextOperation: Operation = operation;
                await this.setNoteTextCallbackAsync(operation);

                // Close is only allowed when saving both title and text is successful
                if (setTitleOperation === Operation.Success && setTextOperation === Operation.Success) {
                    log.info(`Closing note with id=${this.noteId} after saving changes.`);
                    this.cleanup();
                    let window: BrowserWindow = remote.getCurrentWindow();
                    window.close();
                }
            });
        });
    }

    private getNoteDetailsCallback(result: NoteDetailsResult) {
        this.zone.run(() => {
            this.initialNoteTitle = result.noteTitle;
            this.noteTitle = result.noteTitle;
            this.notebookName = result.notebookName;
            this.isMarked = result.isMarked;

            this.setWindowTitle(result.noteTitle);
        });
    }

    private setWindowTitle(noteTitle: string): void {
        let window: BrowserWindow = remote.getCurrentWindow();
        window.setTitle(noteTitle);
    }

    private noteMarkChangedHandler(noteId: string, isMarked: boolean) {
        if (this.noteId === noteId) {
            this.zone.run(() => this.isMarked = isMarked);
        }
    }

    private notebookChangedHandler(noteId: string, notebookName: string) {
        if (this.noteId === noteId) {
            this.zone.run(() => this.notebookName = notebookName);
        }
    }

    private focusNoteHandler(noteId: string) {
        if (this.noteId === noteId) {
            let window: BrowserWindow = remote.getCurrentWindow();

            if (window.isMinimized()) {
                window.minimize(); // Workaround for notes not getting restored on Linux
                window.restore();
            }

            window.focus();
        }
    }

    private closeNoteHandler(noteId: string) {
        if (this.noteId === noteId) {
            let window: BrowserWindow = remote.getCurrentWindow();
            window.close();
        }
    }

    private clearSearch() {
        let window: BrowserWindow = remote.getCurrentWindow();
        window.webContents.stopFindInPage("keepSelection");
    }

    private applySearch() {
        this.globalEmitter.emit(Constants.getSearchTextEvent, this.getSearchTextCallback.bind(this));
    }

    private getSearchTextCallback(searchText: string) {
        let window: BrowserWindow = remote.getCurrentWindow();

        // window.webContents.stopFindInPage("keepSelection");

        if (searchText && searchText.length > 0) {
            let searchTextPieces: string[] = searchText.trim().split(" ");
            // For now, we can only search for 1 word.
            window.webContents.findInPage(searchTextPieces[0]);
        }
    }

    private handleNoteMarkToggled(isNoteMarked: boolean) {
        this.zone.run(() => this.isMarked = isNoteMarked);
    }

    private async setNoteTitleCallbackAsync(result: NoteOperationResult): Promise<void> {
        if (result.operation === Operation.Blank) {
            this.zone.run(() => this.noteTitle = this.initialNoteTitle);
            this.snackBarService.noteTitleCannotBeEmptyAsync();
        } else if (result.operation === Operation.Error) {
            this.zone.run(() => this.noteTitle = this.initialNoteTitle);
            let errorText: string = (await this.translateService.get('ErrorTexts.RenameNoteError', { noteTitle: this.initialNoteTitle }).toPromise());

            this.zone.run(() => {
                this.dialog.open(ErrorDialogComponent, {
                    width: '450px', data: { errorText: errorText }
                });
            });
        } else if (result.operation === Operation.Success) {
            this.zone.run(() => {
                this.initialNoteTitle = result.noteTitle;
                this.noteTitle = result.noteTitle;
                this.setWindowTitle(result.noteTitle);
            });
        } else {
            // Do nothing
        }

        this.isTitleDirty = false;
    }

    private writeTextToNoteFile(): void {
        // Update the note file on disk
        let activeCollection: string = this.settingsService.activeCollection;
        let storageDirectory: string = this.settingsService.storageDirectory;
        let jsonContent: string = JSON.stringify(this.quill.getContents());
        fs.writeFileSync(path.join(Utils.collectionToPath(storageDirectory, activeCollection), `${this.noteId}${Constants.noteContentExtension}`), jsonContent);
    }

    private async setNoteTextCallbackAsync(operation: Operation): Promise<void> {
        let showErrorDialog: boolean = false;

        if (operation === Operation.Success) {
            try {
                this.writeTextToNoteFile();
            } catch (error) {
                log.error(`Could not set text for the note with id='${this.noteId}' in the note file. Cause: ${error}`);
                showErrorDialog = true;
            }
        } else if (operation === Operation.Error) {
            showErrorDialog = true;
        } else {
            // Do nothing
        }

        if (showErrorDialog) {
            let errorText: string = (await this.translateService.get('ErrorTexts.UpdateNoteContentError').toPromise());

            this.zone.run(() => {
                this.dialog.open(ErrorDialogComponent, {
                    width: '450px', data: { errorText: errorText }
                });
            });
        }

        this.isTextDirty = false;
    }

    private async getNoteDetailsAsync(): Promise<void> {
        // Details from data store
        while (!this.noteTitle) {
            // While, is a workaround for auto reload. CollectionService is not ready to
            // listen to events after a auto reload. So we keep trying, until it responds.
            await Utils.sleep(50);
            this.globalEmitter.emit(Constants.getNoteDetailsEvent, this.noteId, this.getNoteDetailsCallback.bind(this));
        }

        // Details from note file
        try {
            let activeCollection: string = this.settingsService.activeCollection;
            let storageDirectory: string = this.settingsService.storageDirectory;
            let noteContent: string = fs.readFileSync(path.join(Utils.collectionToPath(storageDirectory, activeCollection), `${this.noteId}${Constants.noteContentExtension}`), 'utf8');

            if (noteContent) {
                // We can only parse to json if there is content
                this.quill.setContents(JSON.parse(noteContent), 'silent');
            }
        } catch (error) {
            log.error(`Could not get the content for the note with id='${this.noteId}'. Cause: ${error}`);

            let errorText: string = (await this.translateService.get('ErrorTexts.GetNoteContentError').toPromise());

            this.dialog.open(ErrorDialogComponent, {
                width: '450px', data: { errorText: errorText }
            });
        }
    }

    private sendCommandToWorker(command: string, content: any): void {
        ipcRenderer.send(command, content);
    }

    public strikeThrough(event: any) {
        let range: any = this.quill.getSelection();
        let format: any = this.quill.getFormat(range.index, range.length);
        let formatString: string = JSON.stringify(format);

        let applyStrikeThrough: boolean = !formatString.includes("strike");
        this.quill.formatText(range.index, range.length, 'strike', applyStrikeThrough);
    }
}
